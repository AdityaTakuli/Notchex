using System;
using System.Linq;
using System.Threading.Tasks;
using System.Threading;
using System.Windows;
using Notchex.Services;

namespace Notchex
{
    /* Starts everything once. A second launch (from the Start menu, or
       "Notchex Settings") doesn't start another copy: it asks the running
       one to open its settings window. */
    public partial class App : Application
    {
        const string MutexName = @"Local\Notchex.App";
        const string OpenSettingsEvent = @"Local\Notchex.OpenSettings";

        Mutex? _single;
        EventWaitHandle? _openSettings;
        RegisteredWaitHandle? _wait;

        public Settings Settings { get; private set; } = new();
        public MediaService Media { get; } = new();
        public VolumeService Volume { get; } = new();
        public PowerService Power { get; } = new();

        IslandWindow? _island;
        SettingsWindow? _settingsWindow;
        Tray? _tray;

        public static new App Current => (App)Application.Current;

        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);
            /* a bad event from Windows or another app shouldn't take the notch down */
            DispatcherUnhandledException += (_, ev) => { Log.Error("ui", ev.Exception); ev.Handled = true; };
            AppDomain.CurrentDomain.UnhandledException += (_, ev) => Log.Error("fatal", ev.ExceptionObject as Exception);
            System.Threading.Tasks.TaskScheduler.UnobservedTaskException += (_, ev) => { Log.Error("task", ev.Exception); ev.SetObserved(); };

            bool wantsSettings = e.Args.Any(a => a.Equals("--settings", StringComparison.OrdinalIgnoreCase));

            _single = new Mutex(true, MutexName, out bool first);
            if (!first)
            {
                try
                {
                    using var ev = EventWaitHandle.OpenExisting(OpenSettingsEvent);
                    ev.Set();
                }
                catch { }
                Shutdown();
                return;
            }
            _openSettings = new EventWaitHandle(false, EventResetMode.AutoReset, OpenSettingsEvent);
            _wait = ThreadPool.RegisterWaitForSingleObject(_openSettings,
                (_, _) => Dispatcher.BeginInvoke(OpenSettings), null, -1, false);

            Settings = Settings.Load();
            ShellIntegration.EnsureStartMenu();
            ShellIntegration.SetRunAtStartup(Settings.RunAtStartup);

            Volume.Start();
            Power.Start();
            _ = Media.StartAsync();

            _island = new IslandWindow();
            _island.Show();
            _tray = new Tray(this);

            /* first run: say hello with the settings window */
            if (wantsSettings || !System.IO.File.Exists(SettingsPath())) OpenSettings();
            Settings.Save();
        }

        static string SettingsPath() => System.IO.Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Notchex", "settings.json");

        public void OpenSettings()
        {
            if (_settingsWindow == null)
            {
                _settingsWindow = new SettingsWindow();
                _settingsWindow.Closed += (_, _) => _settingsWindow = null;
                _settingsWindow.Show();
            }
            if (_settingsWindow.WindowState == WindowState.Minimized)
                _settingsWindow.WindowState = WindowState.Normal;
            _settingsWindow.Activate();
        }

        public void ToggleHub() => _island?.ToggleHub();

        public void SetShape(string shape) => Settings.Update(s => s.Shape = shape);

        public void SetHidden(bool hidden) => Settings.Update(s => s.Hidden = hidden);

        public void Quit()
        {
            Settings.Save();
            _tray?.Dispose();
            _island?.Close();
            Volume.Dispose();
            Power.Dispose();
            _wait?.Unregister(null);
            Shutdown();
        }

        protected override void OnExit(ExitEventArgs e)
        {
            _tray?.Dispose();
            _single?.Dispose();
            base.OnExit(e);
        }
    }
}
