using System;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Media.Imaging;
using Windows.Media.Control;

namespace Notchex.Services
{
    /* What's playing, from Windows' own media session list (the same one
       the volume flyout and lock screen use): Spotify, browsers, Media
       Player, VLC and anything else that reports to it. Event-driven. */
    public sealed class MediaService
    {
        GlobalSystemMediaTransportControlsSessionManager? _mgr;
        GlobalSystemMediaTransportControlsSession? _session;

        public bool HasSession => _session != null;
        public bool Playing { get; private set; }
        public string Title { get; private set; } = "";
        public string Artist { get; private set; } = "";
        public BitmapImage? Art { get; private set; }
        public TimeSpan Duration { get; private set; }

        TimeSpan _position;
        DateTimeOffset _positionAt;

        /* anything changed (state, track, art) */
        public event Action? Changed;
        /* a new track started */
        public event Action? TrackChanged;

        public async Task StartAsync()
        {
            try
            {
                _mgr = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
                _mgr.CurrentSessionChanged += (_, _) => Ui(Attach);
                Ui(Attach);
            }
            catch
            {
                /* very old Windows 10 builds: no media session API */
            }
        }

        /* live position, estimated between Windows' (infrequent) updates */
        public TimeSpan Position
        {
            get
            {
                var p = _position;
                if (Playing) p += DateTimeOffset.Now - _positionAt;
                if (Duration > TimeSpan.Zero && p > Duration) p = Duration;
                return p < TimeSpan.Zero ? TimeSpan.Zero : p;
            }
        }

        void Attach()
        {
            if (_session != null)
            {
                _session.MediaPropertiesChanged -= OnProps;
                _session.PlaybackInfoChanged -= OnPlayback;
                _session.TimelinePropertiesChanged -= OnTimeline;
            }
            _session = _mgr?.GetCurrentSession();
            if (_session == null)
            {
                Playing = false;
                Title = Artist = "";
                Art = null;
                Changed?.Invoke();
                return;
            }
            _session.MediaPropertiesChanged += OnProps;
            _session.PlaybackInfoChanged += OnPlayback;
            _session.TimelinePropertiesChanged += OnTimeline;
            ReadPlayback();
            ReadTimeline();
            _ = ReadPropsAsync(announce: false);
        }

        void OnProps(GlobalSystemMediaTransportControlsSession s, MediaPropertiesChangedEventArgs e) =>
            Ui(() => _ = ReadPropsAsync(announce: true));

        void OnPlayback(GlobalSystemMediaTransportControlsSession s, PlaybackInfoChangedEventArgs e) =>
            Ui(() => { ReadPlayback(); Changed?.Invoke(); });

        void OnTimeline(GlobalSystemMediaTransportControlsSession s, TimelinePropertiesChangedEventArgs e) =>
            Ui(() => { ReadTimeline(); Changed?.Invoke(); });

        void ReadPlayback()
        {
            try
            {
                var info = _session?.GetPlaybackInfo();
                bool was = Playing;
                Playing = info?.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
                if (was != Playing) _positionAt = DateTimeOffset.Now;
            }
            catch { Playing = false; }
        }

        void ReadTimeline()
        {
            try
            {
                var t = _session?.GetTimelineProperties();
                if (t == null) return;
                Duration = t.EndTime - t.StartTime;
                _position = t.Position;
                _positionAt = t.LastUpdatedTime.Year > 2000 ? t.LastUpdatedTime : DateTimeOffset.Now;
            }
            catch { }
        }

        async Task ReadPropsAsync(bool announce)
        {
            var s = _session;
            if (s == null) return;
            try
            {
                var p = await s.TryGetMediaPropertiesAsync();
                if (s != _session || p == null) return;
                string title = Trim(p.Title), artist = Trim(p.Artist);
                bool isNew = title != Title || artist != Artist;
                Title = title;
                Artist = artist;
                if (isNew) Art = await LoadArtAsync(p);
                Changed?.Invoke();
                if (announce && isNew && title.Length > 0) TrackChanged?.Invoke();
            }
            catch { }
        }

        /* other apps set these: keep them to a sane length */
        static string Trim(string? s)
        {
            s = (s ?? "").Trim();
            return s.Length > 300 ? s[..300] : s;
        }

        const long MaxArtBytes = 8 * 1024 * 1024;

        static async Task<BitmapImage?> LoadArtAsync(GlobalSystemMediaTransportControlsSessionMediaProperties p)
        {
            if (p.Thumbnail == null) return null;
            try
            {
                using var ras = await p.Thumbnail.OpenReadAsync();
                /* artwork comes from other apps: refuse anything oversized */
                if (ras.Size > (ulong)MaxArtBytes) return null;
                using var ms = new MemoryStream();
                var src = ras.AsStreamForRead();
                var buf = new byte[81920];
                int n;
                while ((n = await src.ReadAsync(buf)) > 0)
                {
                    if (ms.Length + n > MaxArtBytes) return null;
                    ms.Write(buf, 0, n);
                }
                ms.Position = 0;
                var img = new BitmapImage();
                img.BeginInit();
                img.CacheOption = BitmapCacheOption.OnLoad;
                img.DecodePixelWidth = 160;
                img.StreamSource = ms;
                img.EndInit();
                img.Freeze();
                return img;
            }
            catch { return null; }
        }

        public void PlayPause() => _ = _session?.TryTogglePlayPauseAsync();
        public void Next() => _ = _session?.TrySkipNextAsync();
        public void Previous() => _ = _session?.TrySkipPreviousAsync();

        /* WinRT events arrive on worker threads */
        static void Ui(Action a) => Application.Current?.Dispatcher.BeginInvoke(a);
    }
}
