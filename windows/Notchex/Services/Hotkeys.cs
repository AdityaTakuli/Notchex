using System;
using System.Collections.Generic;
using System.Windows.Interop;

namespace Notchex.Services
{
    /* System-wide shortcuts. Registered on a window handle; Windows sends
       WM_HOTKEY to it when one is pressed anywhere. */
    public sealed class Hotkeys : IDisposable
    {
        readonly IntPtr _hwnd;
        readonly HwndSource _source;
        readonly Dictionary<int, Action> _actions = new();
        int _nextId = 0x4E58; // "NX"

        public Hotkeys(IntPtr hwnd)
        {
            _hwnd = hwnd;
            _source = HwndSource.FromHwnd(hwnd);
            _source.AddHook(Hook);
        }

        /* returns false when another app already owns the combination */
        public bool Register(uint modifiers, uint key, Action action)
        {
            int id = _nextId++;
            if (!Native.RegisterHotKey(_hwnd, id, modifiers | Native.MOD_NOREPEAT, key)) return false;
            _actions[id] = action;
            return true;
        }

        IntPtr Hook(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == Native.WM_HOTKEY && _actions.TryGetValue(wParam.ToInt32(), out var a))
            {
                handled = true;
                a();
            }
            return IntPtr.Zero;
        }

        public void Dispose()
        {
            foreach (var id in _actions.Keys) Native.UnregisterHotKey(_hwnd, id);
            _actions.Clear();
            _source.RemoveHook(Hook);
        }
    }
}
