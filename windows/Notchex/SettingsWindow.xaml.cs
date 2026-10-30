using System;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using Notchex.Services;

namespace Notchex
{
    /* Every control writes straight to Settings, so the notch changes
       while you watch. Load() puts the current values back after a reset. */
    public partial class SettingsWindow : Window
    {
        readonly App _app = App.Current;
        Settings S => _app.Settings;
        bool _loading;

        public SettingsWindow()
        {
            InitializeComponent();
            Load();

            ShapeNotch.Checked += (_, _) => Set(s => s.Shape = "notch");
            ShapePill.Checked += (_, _) => Set(s => s.Shape = "pill");

            Slide(WidthSlider, WidthText, (s, v) => s.Width = v);
            Slide(HeightSlider, HeightText, (s, v) => s.Height = v);
            Slide(HubWidthSlider, HubWidthText, (s, v) => s.HubWidth = v);

            Toggle(ExpandOnHover, (s, v) => s.ExpandOnHover = v);
            Toggle(HideInFullScreen, (s, v) => s.HideInFullScreen = v);
            Toggle(ShowDate, (s, v) => s.ShowDate = v);
            Toggle(ShowBattery, (s, v) => s.ShowBattery = v);
            Toggle(AlertVolume, (s, v) => s.AlertVolume = v);
            Toggle(AlertBattery, (s, v) => s.AlertBattery = v);
            Toggle(AlertMedia, (s, v) => s.AlertMedia = v);
            Toggle(Hidden, (s, v) => s.Hidden = v);
            Toggle(RunAtStartup, (s, v) =>
            {
                s.RunAtStartup = v;
                ShellIntegration.SetRunAtStartup(v);
            });

            ResetButton.Click += (_, _) => { S.ResetToDefaults(); Load(); };
            DoneButton.Click += (_, _) => Close();
            S.Changed += SyncFromSettings;
            Closed += (_, _) => S.Changed -= SyncFromSettings;

            var v = Assembly.GetExecutingAssembly().GetName().Version;
            Version.Text = $"Notchex {v?.Major}.{v?.Minor}.{v?.Build} for Windows";
        }

        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            /* dark title bar and rounded corners to match the window */
            var hwnd = new WindowInteropHelper(this).Handle;
            int on = 1, round = 2;
            Native.DwmSetWindowAttribute(hwnd, Native.DWMWA_USE_IMMERSIVE_DARK_MODE, ref on, sizeof(int));
            Native.DwmSetWindowAttribute(hwnd, Native.DWMWA_WINDOW_CORNER_PREFERENCE, ref round, sizeof(int));
        }

        void Load()
        {
            _loading = true;
            ShapeNotch.IsChecked = !S.IsPill;
            ShapePill.IsChecked = S.IsPill;
            WidthSlider.Value = S.Width;
            HeightSlider.Value = S.Height;
            HubWidthSlider.Value = S.HubWidth;
            ExpandOnHover.IsChecked = S.ExpandOnHover;
            HideInFullScreen.IsChecked = S.HideInFullScreen;
            ShowDate.IsChecked = S.ShowDate;
            ShowBattery.IsChecked = S.ShowBattery;
            AlertVolume.IsChecked = S.AlertVolume;
            AlertBattery.IsChecked = S.AlertBattery;
            AlertMedia.IsChecked = S.AlertMedia;
            RunAtStartup.IsChecked = S.RunAtStartup;
            Hidden.IsChecked = S.Hidden;
            WidthText.Text = $"{S.Width:0}";
            HeightText.Text = $"{S.Height:0}";
            HubWidthText.Text = $"{S.HubWidth:0}";
            ShapeHint.Text = S.IsPill
                ? "A capsule floating just below the top edge, with a light rim."
                : "Joined to the top edge with rounded bottom corners, like a MacBook.";
            _loading = false;
        }

        /* the tray or the notch's own menu changed something */
        void SyncFromSettings()
        {
            if (!_loading) Dispatcher.BeginInvoke(Load);
        }

        void Set(Action<Settings> change)
        {
            if (_loading) return;
            _loading = true;
            S.Update(change);
            _loading = false;
            Load();
        }

        void Slide(Slider slider, TextBlock label, Action<Settings, double> apply)
        {
            slider.ValueChanged += (_, e) =>
            {
                double v = Math.Round(e.NewValue);
                label.Text = $"{v:0}";
                if (!_loading) { _loading = true; S.Update(s => apply(s, v)); _loading = false; }
            };
        }

        void Toggle(CheckBox box, Action<Settings, bool> apply)
        {
            box.Checked += (_, _) => { if (!_loading) Set(s => apply(s, true)); };
            box.Unchecked += (_, _) => { if (!_loading) Set(s => apply(s, false)); };
        }
    }
}
