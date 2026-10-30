using System;
using System.Runtime.InteropServices;
using System.Windows;

namespace Notchex.Services
{
    /* Speaker volume through Core Audio: reads and sets the default
       output's level and mute, and reports every change (keyboard keys,
       the taskbar flyout, apps) the moment it happens. Follows the default
       output when it changes (headphones plugged in, etc.). */
    public sealed class VolumeService : IDisposable
    {
        IMMDeviceEnumerator? _enum;
        IAudioEndpointVolume? _endpoint;
        readonly Callback _callback;
        readonly DeviceWatcher _watcher;
        Guid _ourContext = Guid.NewGuid();

        public float Level { get; private set; }
        public bool Muted { get; private set; }

        /* (fromUs): true when the change came from SetLevel/ToggleMute */
        public event Action<bool>? Changed;

        public VolumeService()
        {
            _callback = new Callback(this);
            _watcher = new DeviceWatcher(this);
        }

        public void Start()
        {
            try
            {
                _enum = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
                _enum.RegisterEndpointNotificationCallback(_watcher);
                Bind();
            }
            catch { _enum = null; }
        }

        void Bind()
        {
            try
            {
                if (_endpoint != null)
                {
                    try { _endpoint.UnregisterControlChangeNotify(_callback); } catch { }
                    Marshal.ReleaseComObject(_endpoint);
                    _endpoint = null;
                }
                if (_enum == null) return;
                _enum.GetDefaultAudioEndpoint(0 /* render */, 1 /* multimedia */, out var device);
                var iid = typeof(IAudioEndpointVolume).GUID;
                device.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out object o);
                _endpoint = (IAudioEndpointVolume)o;
                _endpoint.RegisterControlChangeNotify(_callback);
                _endpoint.GetMasterVolumeLevelScalar(out float lvl);
                _endpoint.GetMute(out bool mute);
                Level = lvl;
                Muted = mute;
                Marshal.ReleaseComObject(device);
            }
            catch { _endpoint = null; }
        }

        public void SetLevel(float level)
        {
            level = Math.Clamp(level, 0f, 1f);
            try
            {
                _endpoint?.SetMasterVolumeLevelScalar(level, ref _ourContext);
                if (level > 0 && Muted) _endpoint?.SetMute(false, ref _ourContext);
            }
            catch { }
        }

        public void ToggleMute()
        {
            try { _endpoint?.SetMute(!Muted, ref _ourContext); } catch { }
        }

        public void Dispose()
        {
            try { if (_endpoint != null) _endpoint.UnregisterControlChangeNotify(_callback); } catch { }
            try { _enum?.UnregisterEndpointNotificationCallback(_watcher); } catch { }
        }

        internal void OnNotify(Guid context, bool muted, float level)
        {
            Application.Current?.Dispatcher.BeginInvoke(() =>
            {
                bool changed = Math.Abs(level - Level) > 0.001f || muted != Muted;
                Level = level;
                Muted = muted;
                if (changed) Changed?.Invoke(context == _ourContext);
            });
        }

        internal void OnDefaultDeviceChanged() =>
            Application.Current?.Dispatcher.BeginInvoke(() => { Bind(); Changed?.Invoke(true); });

        /* ——— Core Audio COM ——— */

        [ComVisible(true)]
        public sealed class Callback : IAudioEndpointVolumeCallback
        {
            readonly VolumeService _owner;
            internal Callback(VolumeService owner) => _owner = owner;

            public int OnNotify(IntPtr data)
            {
                /* AUDIO_VOLUME_NOTIFICATION_DATA: GUID, BOOL muted, float master, ... */
                var ctx = Marshal.PtrToStructure<Guid>(data);
                bool muted = Marshal.ReadInt32(data, 16) != 0;
                float level = BitConverter.Int32BitsToSingle(Marshal.ReadInt32(data, 20));
                _owner.OnNotify(ctx, muted, level);
                return 0;
            }
        }

        [ComVisible(true)]
        public sealed class DeviceWatcher : IMMNotificationClient
        {
            readonly VolumeService _owner;
            internal DeviceWatcher(VolumeService owner) => _owner = owner;

            public int OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)] string id, int state) => 0;
            public int OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)] string id) => 0;
            public int OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)] string id) => 0;

            public int OnDefaultDeviceChanged(int flow, int role, [MarshalAs(UnmanagedType.LPWStr)] string id)
            {
                if (flow == 0 && role == 1) _owner.OnDefaultDeviceChanged();
                return 0;
            }

            public int OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)] string id, PropertyKey key) => 0;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PropertyKey { public Guid fmtid; public int pid; }

        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
        public class MMDeviceEnumeratorCom { }

        [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IMMDeviceEnumerator
        {
            void EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
            void GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
            void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
            void RegisterEndpointNotificationCallback(IMMNotificationClient client);
            void UnregisterEndpointNotificationCallback(IMMNotificationClient client);
        }

        [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IMMDevice
        {
            void Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
                [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        }

        [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IAudioEndpointVolume
        {
            void RegisterControlChangeNotify(IAudioEndpointVolumeCallback notify);
            void UnregisterControlChangeNotify(IAudioEndpointVolumeCallback notify);
            void GetChannelCount(out uint count);
            void SetMasterVolumeLevel(float levelDb, ref Guid context);
            void SetMasterVolumeLevelScalar(float level, ref Guid context);
            void GetMasterVolumeLevel(out float levelDb);
            void GetMasterVolumeLevelScalar(out float level);
            void SetChannelVolumeLevel(uint channel, float levelDb, ref Guid context);
            void SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
            void GetChannelVolumeLevel(uint channel, out float levelDb);
            void GetChannelVolumeLevelScalar(uint channel, out float level);
            void SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
            void GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
        }

        [ComImport, Guid("657804FA-D6AD-4496-8A60-352752AF4F89"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IAudioEndpointVolumeCallback
        {
            [PreserveSig] int OnNotify(IntPtr notifyData);
        }

        [ComImport, Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IMMNotificationClient
        {
            [PreserveSig] int OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)] string id, int state);
            [PreserveSig] int OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)] string id);
            [PreserveSig] int OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)] string id);
            [PreserveSig] int OnDefaultDeviceChanged(int flow, int role, [MarshalAs(UnmanagedType.LPWStr)] string id);
            [PreserveSig] int OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)] string id, PropertyKey key);
        }
    }
}
