using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;

namespace Notchex
{
    /* "Keep a bar": a black strip across the top of the main screen that the
       notch sits on. Windows treats it like the taskbar (an "app bar"), so
       maximized windows start below it instead of under the notch. The
       space is given back when the mode changes or Notchex quits. */
    public sealed class TopBarWindow : Window
    {
        IntPtr _hwnd;
        uint _callbackMessage;
        bool _registered;
        bool _removing;
        int _heightPx;

        public TopBarWindow()
        {
            Title = "Notchex bar";
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            ShowInTaskbar = false;
            ShowActivated = false;
            Topmost = true;
            Focusable = false;
            Background = (Brush)Application.Current.FindResource("IslandBrush");
            Left = 0;
            Top = 0;
            Width = 1;
            Height = 1;
        }

        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            _hwnd = new WindowInteropHelper(this).Handle;
            /* no taskbar button, no Alt+Tab, never takes focus */
            Native.AddExStyle(_hwnd, Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE);
            _callbackMessage = Native.RegisterWindowMessage("Notchex.AppBar");
            HwndSource.FromHwnd(_hwnd)?.AddHook(WndProc);
        }

        /* height in device-independent pixels, like the rest of the UI;
           0 gives the space back and hides the bar */
        public void Apply(double height)
        {
            if (height <= 0)
            {
                Unregister();
                if (IsVisible) Hide();
                return;
            }
            if (!IsVisible) Show();
            double scale = VisualTreeHelper.GetDpi(this).DpiScaleY;
            _heightPx = Math.Max(1, (int)Math.Round(height * scale));
            if (!_registered)
            {
                var data = Data();
                data.uCallbackMessage = _callbackMessage;
                _registered = Native.SHAppBarMessage(Native.ABM_NEW, ref data) != UIntPtr.Zero;
            }
            Position();
        }

        /* close for good (Notchex is quitting) */
        public void Remove()
        {
            _removing = true;
            Close();
        }

        void Position()
        {
            var screen = System.Windows.Forms.Screen.PrimaryScreen;
            if (screen == null || _hwnd == IntPtr.Zero) return;
            var b = screen.Bounds;   // physical pixels: the app is per-monitor DPI aware
            var data = Data();
            data.uEdge = Native.ABE_TOP;
            data.rc = new Native.RECT { Left = b.Left, Top = b.Top, Right = b.Right, Bottom = b.Top + _heightPx };
            if (_registered)
            {
                /* Windows may move it (below a taskbar on the top edge, say) */
                Native.SHAppBarMessage(Native.ABM_QUERYPOS, ref data);
                data.rc.Bottom = data.rc.Top + _heightPx;
                Native.SHAppBarMessage(Native.ABM_SETPOS, ref data);
            }
            Native.MoveWindow(_hwnd, data.rc.Left, data.rc.Top, data.rc.Right - data.rc.Left, _heightPx, true);
        }

        IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (_registered && msg == (int)_callbackMessage)
            {
                switch (wParam.ToInt32())
                {
                    case Native.ABN_POSCHANGED:
                        Position();
                        break;
                    case Native.ABN_FULLSCREENAPP:
                        /* step behind a full-screen app, come back after */
                        bool fullScreen = lParam != IntPtr.Zero;
                        Topmost = !fullScreen;
                        if (fullScreen) Native.SendToBack(_hwnd);
                        break;
                }
                handled = true;
            }
            return IntPtr.Zero;
        }

        /* closed from outside (an installer asking Notchex to close, say):
           quit properly so the space is given back */
        protected override void OnClosing(CancelEventArgs e)
        {
            if (!_removing)
            {
                e.Cancel = true;
                Dispatcher.BeginInvoke(new Action(() => App.Current.Quit()));
                return;
            }
            base.OnClosing(e);
        }

        protected override void OnClosed(EventArgs e)
        {
            Unregister();
            base.OnClosed(e);
        }

        void Unregister()
        {
            if (!_registered) return;
            var data = Data();
            Native.SHAppBarMessage(Native.ABM_REMOVE, ref data);
            _registered = false;
        }

        Native.APPBARDATA Data() => new()
        {
            cbSize = (uint)Marshal.SizeOf<Native.APPBARDATA>(),
            hWnd = _hwnd,
        };
    }
}
