using System;
using System.Runtime.InteropServices;

/* Windows DLLs we call into load from System32 only, never from the folder
   the exe sits in (Downloads, say), so a planted DLL there is ignored. */
[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

namespace Notchex
{
    /* The few Win32 calls WPF doesn't wrap. */
    internal static class Native
    {
        public const int GWL_EXSTYLE = -20;
        public const long WS_EX_TOOLWINDOW = 0x00000080;   // no taskbar button, no Alt+Tab
        public const long WS_EX_NOACTIVATE = 0x08000000;   // clicking doesn't steal focus

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
        public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
        public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

        public static void AddExStyle(IntPtr hwnd, long bits)
        {
            long cur = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
            SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(cur | bits));
        }

        /* stay above other always-on-top windows without taking focus */
        [DllImport("user32.dll")]
        static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

        public static void KeepOnTop(IntPtr hwnd)
        {
            const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10;
            SetWindowPos(hwnd, new IntPtr(-1) /* HWND_TOPMOST */, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
        }

        /* global shortcuts */
        public const int WM_HOTKEY = 0x0312;
        public const uint MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_SHIFT = 0x4, MOD_WIN = 0x8, MOD_NOREPEAT = 0x4000;

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        /* is a full-screen app, game or presentation running? */
        [DllImport("shell32.dll")]
        public static extern int SHQueryUserNotificationState(out int state);

        public static bool FullScreenAppRunning()
        {
            try
            {
                if (SHQueryUserNotificationState(out int s) != 0) return false;
                return s == 2 /* BUSY */ || s == 3 /* D3D full screen */ || s == 4 /* presentation */;
            }
            catch { return false; }
        }

        /* dark title bar and Mica for the settings window */
        [DllImport("dwmapi.dll")]
        public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        [StructLayout(LayoutKind.Sequential)]
        public struct MARGINS { public int Left, Right, Top, Bottom; }

        [DllImport("dwmapi.dll")]
        public static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref MARGINS margins);

        public const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
        public const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        public const int DWMWA_SYSTEMBACKDROP_TYPE = 38;

        public static bool IsWindows11_22H2 => Environment.OSVersion.Version.Build >= 22621;
    }
}
