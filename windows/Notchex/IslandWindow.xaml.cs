using System;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Shapes;
using System.Windows.Threading;
using Microsoft.Win32;
using Notchex.Services;

namespace Notchex
{
    /* The notch itself. Three states share one black shape that morphs
       between them:
         idle  – album art (or the date) | clock | music bars (or battery)
         alert – a short message: volume, battery, a new track
         hub   – opens on hover: music with controls, volume, battery */
    public partial class IslandWindow : Window
    {
        enum Mode { Idle, Alert, Hub }

        const double Ear = 10;          // inverse corners of the notch
        const double HubRadius = 24;
        const double WindowHeight = 420;

        readonly App _app = App.Current;
        Settings S => _app.Settings;

        Mode _mode = Mode.Idle;
        bool _stickyHub;                // opened from the keyboard or tray
        bool _syncingVolume;
        double _alertWidth = 300;

        readonly DispatcherTimer _clock, _hoverIn, _hoverOut, _alertTimer, _bars, _watch, _progress;
        readonly Rectangle[] _barRects = new Rectangle[4];
        readonly Random _rng = new();
        Hotkeys? _hotkeys;

        /* ——— the shape is three animated numbers ——— */

        public static readonly DependencyProperty IslandWProperty = Geometry("IslandW");
        public static readonly DependencyProperty IslandHProperty = Geometry("IslandH");
        public static readonly DependencyProperty RadiusProperty = Geometry("Radius");

        static DependencyProperty Geometry(string name) =>
            DependencyProperty.Register(name, typeof(double), typeof(IslandWindow),
                new PropertyMetadata(0.0, (d, _) => ((IslandWindow)d).ApplyGeometry()));

        double IslandW => (double)GetValue(IslandWProperty);
        double IslandH => (double)GetValue(IslandHProperty);
        double Radius => (double)GetValue(RadiusProperty);

        public IslandWindow()
        {
            InitializeComponent();

            for (int i = 0; i < _barRects.Length; i++)
            {
                _barRects[i] = new Rectangle { Width = 3, Height = 4, RadiusX = 1.5, RadiusY = 1.5, Fill = Brushes.White,
                                               Margin = new Thickness(1, 0, 1, 0), VerticalAlignment = VerticalAlignment.Center };
                Bars.Children.Add(_barRects[i]);
            }
            var ear = System.Windows.Media.Geometry.Parse($"M0,0 H{Ear} V{Ear} A{Ear},{Ear} 0 0 0 0,0 Z");
            EarLeft.Data = ear;
            EarRight.Data = ear;

            _clock = Timer(1000, UpdateClock);
            _hoverIn = Timer(180, () => { _hoverIn!.Stop(); Expand(sticky: false); });
            _hoverOut = Timer(380, () => { _hoverOut!.Stop(); if (!Island.IsMouseOver) Collapse(); });
            _alertTimer = Timer(2200, () => { _alertTimer!.Stop(); if (_mode == Mode.Alert) ToIdle(); });
            _bars = Timer(150, AnimateBars);
            _watch = Timer(1500, Watch);
            _progress = Timer(500, UpdateProgress);

            Island.MouseEnter += (_, _) => OnPointerEnter();
            Island.MouseLeave += (_, _) => OnPointerLeave();
            Island.MouseLeftButtonUp += (_, e) => { if (_mode != Mode.Hub) { Expand(sticky: false); e.Handled = true; } };
            Island.MouseWheel += (_, e) => Nudge(e.Delta > 0 ? 0.04f : -0.04f);
            Island.ContextMenu = BuildMenu();

            PrevButton.Click += (_, _) => _app.Media.Previous();
            NextButton.Click += (_, _) => _app.Media.Next();
            PlayButton.Click += (_, _) => _app.Media.PlayPause();
            MuteButton.Click += (_, _) => _app.Volume.ToggleMute();
            SettingsButton.Click += (_, _) => { Collapse(); _app.OpenSettings(); };
            VolumeSlider.ValueChanged += (_, e) =>
            {
                if (!_syncingVolume) _app.Volume.SetLevel((float)(e.NewValue / 100));
            };

            _app.Media.Changed += OnMedia;
            _app.Media.TrackChanged += OnTrack;
            _app.Volume.Changed += OnVolume;
            _app.Power.Changed += OnPower;
            _app.Power.Alert += OnPowerAlert;
            S.Changed += ApplySettings;
            SystemEvents.DisplaySettingsChanged += (_, _) => Dispatcher.BeginInvoke(Place);

            Height = WindowHeight;
            ApplySettings();
            SetValue(IslandWProperty, S.Width);
            SetValue(IslandHProperty, S.Height);
            SetValue(RadiusProperty, S.Height / 2);
            UpdateClock();
            OnMedia();
            OnVolume(true);
            OnPower();
            _clock.Start();
            _watch.Start();
        }

        DispatcherTimer Timer(int ms, Action tick)
        {
            var t = new DispatcherTimer(DispatcherPriority.Normal, Dispatcher) { Interval = TimeSpan.FromMilliseconds(ms) };
            t.Tick += (_, _) => tick();
            return t;
        }

        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            var hwnd = new WindowInteropHelper(this).Handle;
            /* no taskbar button, no Alt+Tab, and clicking doesn't steal focus */
            Native.AddExStyle(hwnd, Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE);

            _hotkeys = new Hotkeys(hwnd);
            _hotkeys.Register(Native.MOD_CONTROL | Native.MOD_ALT, 0x4E /* N */, ToggleHub);
            _hotkeys.Register(Native.MOD_CONTROL | Native.MOD_ALT, 0xBC /* , */, () => _app.OpenSettings());
        }

        protected override void OnClosed(EventArgs e)
        {
            _hotkeys?.Dispose();
            base.OnClosed(e);
        }

        /* ——— placement and shape ——— */

        void Place()
        {
            Width = Math.Max(S.HubWidth, 420) + Ear * 2 + 48;
            Left = (SystemParameters.PrimaryScreenWidth - Width) / 2;
            Top = 0;
        }

        void ApplySettings()
        {
            Place();
            bool pill = S.IsPill;
            EarLeft.Visibility = EarRight.Visibility = pill ? Visibility.Collapsed : Visibility.Visible;
            EarLeft.Width = EarLeft.Height = EarRight.Width = EarRight.Height = Ear;
            Island.Margin = new Thickness(0, pill ? S.TopMargin : 0, 0, 0);
            Island.BorderThickness = new Thickness(pill ? 1 : 0);
            Island.Effect = pill ? new DropShadowEffect { BlurRadius = 16, ShadowDepth = 3, Direction = 270, Opacity = 0.35 } : null;
            UpdateIdle();
            Watch();
            switch (_mode)
            {
                case Mode.Idle: AnimateTo(S.Width, S.Height, 260, spring: false); break;
                case Mode.Hub: AnimateTo(S.HubWidth, HubHeight(), 260, spring: false); break;
            }
        }

        void ApplyGeometry()
        {
            double w = IslandW, h = IslandH, r = Math.Min(Radius, h / 2);
            if (w <= 0 || h <= 0) return;
            Island.Width = w;
            Island.Height = h;
            Island.CornerRadius = S.IsPill ? new CornerRadius(r) : new CornerRadius(0, 0, r, r);
        }

        void AnimateTo(double w, double h, int ms, bool spring)
        {
            IEasingFunction ease = spring
                ? new BackEase { EasingMode = EasingMode.EaseOut, Amplitude = 0.35 }
                : new CubicEase { EasingMode = EasingMode.EaseOut };
            var d = new Duration(TimeSpan.FromMilliseconds(SystemParameters.ClientAreaAnimation ? ms : 0));
            double r = h <= 60 ? h / 2 : HubRadius;
            BeginAnimation(IslandWProperty, new DoubleAnimation(w, d) { EasingFunction = ease });
            BeginAnimation(IslandHProperty, new DoubleAnimation(h, d) { EasingFunction = ease });
            BeginAnimation(RadiusProperty, new DoubleAnimation(r, d) { EasingFunction = ease });
        }

        /* fade one view in and the others out */
        void Show(FrameworkElement view)
        {
            foreach (var v in new FrameworkElement[] { IdleView, AlertView, HubView })
            {
                bool on = v == view;
                var anim = new DoubleAnimation(on ? 1 : 0, TimeSpan.FromMilliseconds(on ? 200 : 110))
                {
                    BeginTime = TimeSpan.FromMilliseconds(on ? 90 : 0),
                };
                if (on) v.Visibility = Visibility.Visible;
                else anim.Completed += (_, _) => { if (v.Opacity == 0) v.Visibility = Visibility.Collapsed; };
                v.BeginAnimation(OpacityProperty, anim);
            }
        }

        /* ——— states ——— */

        void ToIdle()
        {
            _mode = Mode.Idle;
            _stickyHub = false;
            _progress.Stop();
            UpdateIdle();
            Show(IdleView);
            AnimateTo(S.Width, S.Height, 320, spring: false);
        }

        void Expand(bool sticky)
        {
            if (_mode == Mode.Hub) return;
            _alertTimer.Stop();
            _mode = Mode.Hub;
            _stickyHub = sticky;
            UpdateHub();
            Show(HubView);
            AnimateTo(S.HubWidth, HubHeight(), 340, spring: false);
            _progress.Start();
            if (sticky) _hoverOut.Interval = TimeSpan.FromSeconds(6);
            if (sticky && !Island.IsMouseOver) _hoverOut.Start();
        }

        void Collapse()
        {
            if (_mode != Mode.Hub) return;
            _hoverOut.Interval = TimeSpan.FromMilliseconds(380);
            ToIdle();
        }

        public void ToggleHub()
        {
            if (Visibility != Visibility.Visible) return;   // hidden, or a full-screen app is up
            if (_mode == Mode.Hub) Collapse();
            else Expand(sticky: true);
        }

        double HubHeight()
        {
            var was = HubView.Visibility;
            HubView.Visibility = Visibility.Visible;
            HubView.Measure(new Size(S.HubWidth, double.PositiveInfinity));
            if (was != Visibility.Visible && HubView.Opacity == 0) HubView.Visibility = was;
            return Math.Ceiling(HubView.DesiredSize.Height);
        }

        void OnPointerEnter()
        {
            _hoverOut.Stop();
            _hoverOut.Interval = TimeSpan.FromMilliseconds(380);
            if (S.ExpandOnHover && _mode != Mode.Hub) _hoverIn.Start();
        }

        void OnPointerLeave()
        {
            _hoverIn.Stop();
            if (_mode == Mode.Hub) _hoverOut.Start();
        }

        /* ——— alerts ——— */

        void ShowAlert(string icon, string label, string value, Brush? valueBrush = null,
                       double? meter = null, ImageSource? art = null, double width = 300)
        {
            if (_mode == Mode.Hub) return;
            AlertIcon.Text = icon;
            AlertIcon.Visibility = art == null ? Visibility.Visible : Visibility.Collapsed;
            AlertArt.Visibility = art == null ? Visibility.Collapsed : Visibility.Visible;
            if (art != null) AlertArt.Background = new ImageBrush(art) { Stretch = Stretch.UniformToFill };
            AlertLabel.Text = label;
            AlertValue.Text = value;
            AlertValue.Foreground = valueBrush ?? (Brush)FindResource("TextBrush");
            AlertTrack.Visibility = meter == null ? Visibility.Collapsed : Visibility.Visible;
            if (meter != null) AlertFill.Width = AlertTrack.Width * Math.Clamp(meter.Value, 0, 1);

            bool fresh = _mode != Mode.Alert || Math.Abs(width - _alertWidth) > 1;
            _alertWidth = width;
            _mode = Mode.Alert;
            if (AlertView.Opacity < 1 || AlertView.Visibility != Visibility.Visible) Show(AlertView);
            if (fresh) AnimateTo(width, S.Height, 420, spring: true);
            _alertTimer.Stop();
            _alertTimer.Start();
        }

        void OnTrack()
        {
            if (!S.AlertMedia || _mode == Mode.Hub) return;
            var m = _app.Media;
            ShowAlert("", m.Title, m.Playing ? "" : "Paused", art: m.Art, width: 340);
        }

        void OnVolume(bool fromUs)
        {
            var v = _app.Volume;
            int pct = (int)Math.Round(v.Level * 100);
            _syncingVolume = true;
            VolumeSlider.Value = pct;
            _syncingVolume = false;
            VolumeText.Text = v.Muted ? "Off" : $"{pct}%";
            MuteButton.Content = VolumeGlyph(v.Level, v.Muted);
            /* keyboard keys or the taskbar flyout; or a volume alert already showing (scrolling) */
            bool showingVolume = _mode == Mode.Alert && AlertLabel.Text == "Volume";
            if ((!fromUs && S.AlertVolume) || showingVolume) VolumeAlert();
        }

        void VolumeAlert()
        {
            var v = _app.Volume;
            ShowAlert(VolumeGlyph(v.Level, v.Muted), "Volume", v.Muted ? "Off" : $"{Math.Round(v.Level * 100)}%",
                      meter: v.Muted ? 0 : v.Level, width: 300);
        }

        void Nudge(float delta)
        {
            var v = _app.Volume;
            v.SetLevel(v.Level + delta);
            if (_mode != Mode.Hub) VolumeAlert();   // updated again when Windows confirms the new level
        }

        static string VolumeGlyph(float level, bool muted) =>
            muted || level <= 0.001f ? "" : level < 0.34f ? "" : level < 0.67f ? "" : "";

        void OnPowerAlert(PowerAlert a)
        {
            if (!S.AlertBattery) return;
            var p = _app.Power;
            var green = (Brush)FindResource("GreenBrush");
            var red = (Brush)FindResource("RedBrush");
            switch (a)
            {
                case PowerAlert.PluggedIn: ShowAlert(BatteryGlyph(p.Percent, true), "Charging", $"{p.Percent}%", green); break;
                case PowerAlert.Unplugged: ShowAlert(BatteryGlyph(p.Percent, false), "On Battery", $"{p.Percent}%"); break;
                case PowerAlert.Low: ShowAlert(BatteryGlyph(p.Percent, false), "Low Battery", $"{p.Percent}%", red); break;
                case PowerAlert.Critical: ShowAlert(BatteryGlyph(p.Percent, false), "Battery Critical", $"{p.Percent}%", red); break;
                case PowerAlert.Full: ShowAlert(BatteryGlyph(100, true), "Fully Charged", "100%", green); break;
            }
        }

        /* Segoe Fluent battery glyphs: 0–10 bars, plain or charging */
        static string BatteryGlyph(int pct, bool charging)
        {
            int step = Math.Clamp((int)Math.Round(pct / 10.0), 0, 10);
            if (charging) return step >= 10 ? "" : step == 9 ? "" : ((char)(0xE85A + step)).ToString();
            return step >= 10 ? "" : ((char)(0xE850 + step)).ToString();
        }

        /* ——— content ——— */

        void UpdateClock()
        {
            var now = DateTime.Now;
            var c = CultureInfo.CurrentCulture;
            IdleClock.Text = now.ToString("t", c);
            IdleDate.Text = now.ToString("ddd d", c);
            HubClock.Text = now.ToString("t", c);
            HubDay.Text = now.ToString("dddd", c);
            HubDate.Text = now.ToString("M", c);
        }

        bool HasMedia => _app.Media.HasSession && _app.Media.Title.Length > 0;

        void OnMedia()
        {
            UpdateIdle();
            if (_mode == Mode.Hub) UpdateHub();
        }

        void UpdateIdle()
        {
            var m = _app.Media;
            bool media = HasMedia;
            IdleArt.Visibility = media ? Visibility.Visible : Visibility.Collapsed;
            IdleArt.Background = m.Art != null ? new ImageBrush(m.Art) { Stretch = Stretch.UniformToFill }
                                               : (Brush)new SolidColorBrush(Color.FromArgb(0x33, 255, 255, 255));
            IdleArt.Opacity = m.Playing ? 1 : 0.6;
            IdleDate.Visibility = !media && S.ShowDate ? Visibility.Visible : Visibility.Collapsed;

            Bars.Visibility = media ? Visibility.Visible : Visibility.Collapsed;
            IdleBattery.Visibility = !media && S.ShowBattery && _app.Power.HasBattery ? Visibility.Visible : Visibility.Collapsed;
            if (media && m.Playing && SystemParameters.ClientAreaAnimation) _bars.Start();
            else { _bars.Stop(); foreach (var r in _barRects) { r.BeginAnimation(HeightProperty, null); r.Height = m.Playing ? 8 : 4; } }
        }

        void AnimateBars()
        {
            foreach (var r in _barRects)
                r.BeginAnimation(HeightProperty, new DoubleAnimation(3 + _rng.NextDouble() * 11, TimeSpan.FromMilliseconds(140)));
        }

        void UpdateHub()
        {
            var m = _app.Media;
            bool media = HasMedia;
            HubTitle.Text = media ? m.Title : "Nothing playing";
            HubArtist.Text = media ? m.Artist : "Play something and it shows up here.";
            HubArt.Background = m.Art != null && media ? new ImageBrush(m.Art) { Stretch = Stretch.UniformToFill }
                                                       : (Brush)FindResource("CardBrush");
            HubArtPlaceholder.Visibility = m.Art != null && media ? Visibility.Collapsed : Visibility.Visible;
            PlayButton.Content = m.Playing ? "" : "";
            PrevButton.IsEnabled = NextButton.IsEnabled = PlayButton.IsEnabled = media;
            UpdateProgress();
            OnPower();
        }

        void UpdateProgress()
        {
            var m = _app.Media;
            bool known = HasMedia && m.Duration > TimeSpan.Zero;
            HubElapsed.Text = known ? Format(m.Position) : "";
            HubRemaining.Text = known ? "-" + Format(m.Duration - m.Position) : "";
            double frac = known ? m.Position.TotalSeconds / m.Duration.TotalSeconds : 0;
            HubFill.Width = Math.Max(0, HubTrack.ActualWidth * Math.Clamp(frac, 0, 1));
        }

        static string Format(TimeSpan t) =>
            t.TotalHours >= 1 ? t.ToString(@"h\:mm\:ss") : t.ToString(@"m\:ss");

        void OnPower()
        {
            var p = _app.Power;
            IdleBatteryText.Text = $"{p.Percent}%";
            IdleBatteryIcon.Text = BatteryGlyph(p.Percent, p.Charging);
            IdleBatteryIcon.Foreground = (Brush)FindResource(p.Charging ? "GreenBrush" : p.Percent <= 20 ? "RedBrush" : "TextBrush");
            BatteryCard.Visibility = p.HasBattery ? Visibility.Visible : Visibility.Collapsed;
            HubBatteryIcon.Text = IdleBatteryIcon.Text;
            HubBatteryIcon.Foreground = IdleBatteryIcon.Foreground;
            HubBatteryText.Text = $"{p.Percent}%";
            HubBatteryState.Text = p.Charging ? "Charging" : p.OnAC ? "Plugged in" : "On battery";
            if (_mode == Mode.Idle) UpdateIdle();
        }

        /* hide for full-screen apps, stay above other always-on-top windows */
        void Watch()
        {
            bool hide = S.Hidden || (S.HideInFullScreen && Native.FullScreenAppRunning());
            Visibility = hide ? Visibility.Hidden : Visibility.Visible;
            if (!hide)
            {
                var hwnd = new WindowInteropHelper(this).Handle;
                if (hwnd != IntPtr.Zero) Native.KeepOnTop(hwnd);
            }
        }

        /* ——— right-click menu ——— */

        ContextMenu BuildMenu()
        {
            var menu = new ContextMenu { Style = (Style)FindResource("DarkMenu") };
            MenuItem Item(string text, Action a)
            {
                var mi = new MenuItem { Header = text, Style = (Style)FindResource("DarkMenuItem") };
                mi.Click += (_, _) => a();
                return mi;
            }
            Separator Sep() => new() { Style = (Style)FindResource("DarkSeparator") };

            var notch = Item("Notch", () => _app.SetShape("notch"));
            var pill = Item("Pill", () => _app.SetShape("pill"));
            var hide = Item("Hide Notch", () => _app.SetHidden(true));
            menu.Items.Add(Item("Open Notchex", () => Expand(sticky: true)));
            menu.Items.Add(Item("Notchex Settings…", () => _app.OpenSettings()));
            menu.Items.Add(Sep());
            menu.Items.Add(notch);
            menu.Items.Add(pill);
            menu.Items.Add(Sep());
            menu.Items.Add(hide);
            menu.Items.Add(Item("Quit Notchex", () => _app.Quit()));
            menu.Opened += (_, _) =>
            {
                _hoverIn.Stop();
                notch.IsChecked = !S.IsPill;
                pill.IsChecked = S.IsPill;
            };
            return menu;
        }
    }
}
