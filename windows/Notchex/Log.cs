using System;
using System.IO;

namespace Notchex
{
    /* A small local error log: %LOCALAPPDATA%\Notchex\notchex.log.
       Only error types and stack traces go in, never song titles or other
       content, and nothing is ever sent anywhere. Kept under 256 KB. */
    internal static class Log
    {
        const long MaxBytes = 256 * 1024;
        static readonly object Gate = new();

        static string Dir => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Notchex");
        public static string FilePath => Path.Combine(Dir, "notchex.log");

        public static void Error(string where, Exception? e)
        {
            if (e == null) return;
            try
            {
                lock (Gate)
                {
                    Directory.CreateDirectory(Dir);
                    var info = new FileInfo(FilePath);
                    if (info.Exists && info.Length > MaxBytes)
                        File.Move(FilePath, FilePath + ".old", overwrite: true);
                    /* type and stack only: exception messages can quote user content */
                    File.AppendAllText(FilePath,
                        $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} [{where}] {e.GetType().FullName} (0x{e.HResult:X8}){Environment.NewLine}" +
                        $"{e.StackTrace}{Environment.NewLine}{Environment.NewLine}");
                }
            }
            catch { /* logging must never crash the app */ }
        }
    }
}
