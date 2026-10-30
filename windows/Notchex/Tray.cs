using System;
using System.Drawing;
using Forms = System.Windows.Forms;

namespace Notchex
{
    /* The icon by the clock. Left-click opens the notch, right-click has
       the same menu as right-clicking the notch itself. */
    public sealed class Tray : IDisposable
    {
        readonly App _app;
        readonly Forms.NotifyIcon _icon;
        readonly Forms.ToolStripMenuItem _notch, _pill, _hide;

        public Tray(App app)
        {
            _app = app;
            var menu = new Forms.ContextMenuStrip();
            menu.Items.Add("Open Notchex", null, (_, _) => _app.ToggleHub());
            menu.Items.Add("Notchex Settings…", null, (_, _) => _app.OpenSettings());
            menu.Items.Add(new Forms.ToolStripSeparator());
            _notch = new Forms.ToolStripMenuItem("Notch", null, (_, _) => _app.SetShape("notch"));
            _pill = new Forms.ToolStripMenuItem("Pill", null, (_, _) => _app.SetShape("pill"));
            menu.Items.Add(_notch);
            menu.Items.Add(_pill);
            menu.Items.Add(new Forms.ToolStripSeparator());
            _hide = new Forms.ToolStripMenuItem("Hide Notch", null, (_, _) => _app.SetHidden(!_app.Settings.Hidden));
            menu.Items.Add(_hide);
            menu.Items.Add("Quit Notchex", null, (_, _) => _app.Quit());
            menu.Opening += (_, _) => Sync();

            _icon = new Forms.NotifyIcon
            {
                Icon = LoadIcon(),
                Text = "Notchex",
                ContextMenuStrip = menu,
                Visible = true,
            };
            _icon.MouseClick += (_, e) =>
            {
                if (e.Button == Forms.MouseButtons.Left) _app.ToggleHub();
            };
        }

        void Sync()
        {
            _notch.Checked = !_app.Settings.IsPill;
            _pill.Checked = _app.Settings.IsPill;
            _hide.Text = _app.Settings.Hidden ? "Show Notch" : "Hide Notch";
        }

        static Icon LoadIcon()
        {
            try
            {
                var path = Environment.ProcessPath;
                if (path != null) return Icon.ExtractAssociatedIcon(path) ?? SystemIcons.Application;
            }
            catch { }
            return SystemIcons.Application;
        }

        bool _disposed;

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _icon.Visible = false;
            _icon.Dispose();
        }
    }
}
