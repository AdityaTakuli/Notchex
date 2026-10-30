using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Threading;

namespace Notchex
{
    /* Everything the user can change, stored as JSON in
       %APPDATA%\Notchex\settings.json. Changes apply at once (Changed)
       and are written to disk a moment later. */
    public sealed class Settings
    {
        public string Shape { get; set; } = "notch";      // "notch" or "pill"
        public double Width { get; set; } = 220;          // idle width, px
        public double Height { get; set; } = 36;          // idle height, px
        public double TopMargin { get; set; } = 6;        // space above the pill
        public double HubWidth { get; set; } = 560;

        public bool ExpandOnHover { get; set; } = true;
        public bool HideInFullScreen { get; set; } = true;
        public bool ShowDate { get; set; } = true;
        public bool ShowBattery { get; set; } = true;

        public bool AlertVolume { get; set; } = true;
        public bool AlertBattery { get; set; } = true;
        public bool AlertMedia { get; set; } = true;

        public bool RunAtStartup { get; set; }
        public bool Hidden { get; set; }

        [JsonIgnore] public bool IsPill => Shape == "pill";

        public event Action? Changed;

        static string Dir => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Notchex");
        static string FilePath => Path.Combine(Dir, "settings.json");

        DispatcherTimer? _saveTimer;

        const long MaxFileBytes = 64 * 1024;

        public static Settings Load()
        {
            try
            {
                var info = new FileInfo(FilePath);
                if (info.Exists)
                {
                    if (info.Length > MaxFileBytes) throw new InvalidDataException("settings file too large");
                    var s = JsonSerializer.Deserialize<Settings>(File.ReadAllText(FilePath)) ?? new Settings();
                    s.Sanitize();
                    return s;
                }
            }
            catch
            {
                /* keep the broken file for the user to look at, start from defaults */
                try { File.Copy(FilePath, FilePath + ".broken", overwrite: true); } catch { }
            }
            return new Settings();
        }

        /* hand-edited or damaged values can't make the notch huge, tiny or invisible */
        public void Sanitize()
        {
            static double Clamp(double v, double lo, double hi, double fallback) =>
                double.IsFinite(v) ? Math.Clamp(v, lo, hi) : fallback;
            Shape = Shape == "pill" ? "pill" : "notch";
            Width = Clamp(Width, 160, 380, 220);
            Height = Clamp(Height, 28, 46, 36);
            TopMargin = Clamp(TopMargin, 0, 24, 6);
            HubWidth = Clamp(HubWidth, 480, 720, 560);
        }

        /* change something: s.Update(x => x.Shape = "pill") */
        public void Update(Action<Settings> change)
        {
            change(this);
            Sanitize();
            Changed?.Invoke();
            _saveTimer ??= new DispatcherTimer(TimeSpan.FromMilliseconds(400), DispatcherPriority.Background,
                (_, _) => { _saveTimer!.Stop(); Save(); }, Dispatcher.CurrentDispatcher);
            _saveTimer.Stop();
            _saveTimer.Start();
        }

        public void ResetToDefaults()
        {
            var d = new Settings();
            Update(s =>
            {
                foreach (var p in typeof(Settings).GetProperties())
                    if (p.CanWrite && p.Name != nameof(RunAtStartup) && p.Name != nameof(Hidden))
                        p.SetValue(s, p.GetValue(d));
            });
        }

        public void Save()
        {
            try
            {
                Directory.CreateDirectory(Dir);
                /* write a temp file and swap it in, so a crash mid-write can't leave half a file */
                var tmp = FilePath + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
                File.Move(tmp, FilePath, overwrite: true);
            }
            catch { /* read-only profile: settings just won't persist */ }
        }
    }
}
