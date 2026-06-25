using System;
using System.IO;
using System.Threading.Tasks;
using Windows.Media.Control;
using Windows.Storage.Streams;

// Reads the current media session from Windows System Media Transport Controls.
// Works with Spotify, browsers, VLC, or any SMTC-aware player — no API keys needed.
//
// Output format (pipe-delimited):
//   title|artist|album|positionSeconds|durationSeconds|artPath|status
//
// status = "playing" | "paused" | "stopped"

class Program {
    static Program() { Console.OutputEncoding = System.Text.Encoding.UTF8; }

    static async Task Main() {
        try {
            var manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
            var session = manager.GetCurrentSession();

            if (session == null) {
                Console.WriteLine("stopped");
                return;
            }

            var props = await session.TryGetMediaPropertiesAsync();
            var pb    = session.GetPlaybackInfo();
            var tl    = session.GetTimelineProperties();

            var status = pb.PlaybackStatus switch {
                GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing => "playing",
                GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused  => "paused",
                _                                                                => "stopped"
            };

            if (status == "stopped") {
                Console.WriteLine("stopped");
                return;
            }

            int pos = (int)tl.Position.TotalSeconds;
            int dur = (int)tl.EndTime.TotalSeconds;

            string artPath = "";
            if (props.Thumbnail != null) {
                try {
                    artPath = Path.Combine(Path.GetTempPath(), "lyric_status_art.jpg");
                    using var stream = await props.Thumbnail.OpenReadAsync();
                    using var reader = new DataReader(stream);
                    uint size        = (uint)stream.Size;
                    await reader.LoadAsync(size);
                    byte[] bytes     = new byte[size];
                    reader.ReadBytes(bytes);
                    await File.WriteAllBytesAsync(artPath, bytes);
                } catch {
                    artPath = "";
                }
            }

            Console.WriteLine(
                (props.Title      ?? "") + "|" +
                (props.Artist     ?? "") + "|" +
                (props.AlbumTitle ?? "") + "|" +
                pos                      + "|" +
                dur                      + "|" +
                artPath                  + "|" +
                status
            );
        } catch (Exception e) {
            Console.Error.WriteLine(e.Message);
            Console.WriteLine("stopped");
        }
    }
}
