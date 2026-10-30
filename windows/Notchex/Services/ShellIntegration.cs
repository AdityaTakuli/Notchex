using System;
using System.IO;
using Microsoft.Win32;

namespace Notchex.Services
{
    /* Start menu entries ("Notchex" and "Notchex Settings") and starting
       with Windows. Everything is per user: no admin rights needed. */
    public static class ShellIntegration
    {
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string RunName = "Notchex";

        static string Exe => Environment.ProcessPath ?? "";

        static string StartMenuDir => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Notchex");

        public static void SetRunAtStartup(bool on)
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true)
                                ?? Registry.CurrentUser.CreateSubKey(RunKey);
                if (on) key.SetValue(RunName, $"\"{Exe}\"");
                else key.DeleteValue(RunName, throwOnMissingValue: false);
            }
            catch { }
        }

        /* (re)creates the Start menu shortcuts so they follow the exe if it moves */
        public static void EnsureStartMenu()
        {
            try
            {
                Directory.CreateDirectory(StartMenuDir);
                Shortcut(Path.Combine(StartMenuDir, "Notchex.lnk"), "", "A working notch for Windows");
                Shortcut(Path.Combine(StartMenuDir, "Notchex Settings.lnk"), "--settings", "Change how the notch looks and behaves");
            }
            catch { }
        }

        public static void RemoveStartMenu()
        {
            try { if (Directory.Exists(StartMenuDir)) Directory.Delete(StartMenuDir, recursive: true); } catch { }
        }

        static void Shortcut(string path, string args, string description)
        {
            var type = Type.GetTypeFromProgID("WScript.Shell");
            if (type == null || string.IsNullOrEmpty(Exe)) return;
            dynamic shell = Activator.CreateInstance(type)!;
            dynamic link = shell.CreateShortcut(path);
            link.TargetPath = Exe;
            link.Arguments = args;
            link.Description = description;
            link.WorkingDirectory = Path.GetDirectoryName(Exe);
            link.IconLocation = Exe + ",0";
            link.Save();
        }
    }
}
