using System;
using System.Windows.Threading;
using Microsoft.Win32;
using Forms = System.Windows.Forms;

namespace Notchex.Services
{
    public enum PowerAlert { PluggedIn, Unplugged, Low, Critical, Full }

    /* Battery level and charger state. Windows tells us when the charger
       is plugged or unplugged; the level is checked every 30 s for the
       low-battery thresholds. */
    public sealed class PowerService : IDisposable
    {
        public bool HasBattery { get; private set; }
        public int Percent { get; private set; } = 100;
        public bool OnAC { get; private set; } = true;
        public bool Charging => OnAC && Percent < 100;

        public event Action? Changed;
        public event Action<PowerAlert>? Alert;

        DispatcherTimer? _timer;
        bool _warnedLow, _warnedCritical, _announcedFull;

        public void Start()
        {
            Read(announce: false);
            SystemEvents.PowerModeChanged += OnPowerMode;
            _timer = new DispatcherTimer(TimeSpan.FromSeconds(30), DispatcherPriority.Background,
                (_, _) => Read(announce: true), Dispatcher.CurrentDispatcher);
            _timer.Start();
        }

        void OnPowerMode(object? sender, PowerModeChangedEventArgs e)
        {
            if (e.Mode == PowerModes.StatusChange)
                System.Windows.Application.Current?.Dispatcher.BeginInvoke(() => Read(announce: true));
        }

        void Read(bool announce)
        {
            var ps = Forms.SystemInformation.PowerStatus;
            bool hasBattery = (ps.BatteryChargeStatus & Forms.BatteryChargeStatus.NoSystemBattery) == 0 &&
                              ps.BatteryChargeStatus != Forms.BatteryChargeStatus.Unknown;
            int pct = (int)Math.Round(Math.Clamp(ps.BatteryLifePercent, 0f, 1f) * 100);
            bool ac = ps.PowerLineStatus != Forms.PowerLineStatus.Offline;

            bool wasAC = OnAC;
            int was = Percent;
            HasBattery = hasBattery;
            Percent = pct;
            OnAC = ac;
            Changed?.Invoke();
            if (!announce || !hasBattery) return;

            if (ac != wasAC)
            {
                Alert?.Invoke(ac ? PowerAlert.PluggedIn : PowerAlert.Unplugged);
                if (ac) _warnedLow = _warnedCritical = false;
                else _announcedFull = false;
                return;
            }
            if (!ac && pct <= 10 && !_warnedCritical) { _warnedCritical = _warnedLow = true; Alert?.Invoke(PowerAlert.Critical); }
            else if (!ac && pct <= 20 && was > 20 && !_warnedLow) { _warnedLow = true; Alert?.Invoke(PowerAlert.Low); }
            else if (ac && pct >= 100 && was < 100 && !_announcedFull) { _announcedFull = true; Alert?.Invoke(PowerAlert.Full); }
        }

        public void Dispose()
        {
            SystemEvents.PowerModeChanged -= OnPowerMode;
            _timer?.Stop();
        }
    }
}
