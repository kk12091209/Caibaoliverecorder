using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using Newtonsoft.Json.Linq;

#nullable enable
namespace BililiveRecorder.Core.Danmaku
{
    /// <summary>
    /// Recognizes exact, time-bounded participation phrases announced by lottery events.
    /// This does not infer lotteries from repeated text or the ambiguous info[0][9] flag.
    /// Event fields: https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/docs/live/message_stream.md
    /// </summary>
    internal sealed class LotteryDanmakuTracker
    {
        private const long MaxLifetimeMs = 24 * 60 * 60 * 1000;
        private const int MaxActivities = 64;
        private readonly object gate = new object();
        private readonly Dictionary<string, Activity> activities = new Dictionary<string, Activity>();
        private readonly Func<long> clock;
        private int currentRoom;

        private sealed class Activity
        {
            public string Text = string.Empty;
            public long Start;
            public long End;
            public long Expires;
            public bool Closed;
        }

        internal LotteryDanmakuTracker(Func<long>? clock = null)
        {
            this.clock = clock ?? (() => (long)(Stopwatch.GetTimestamp() * (1000d / Stopwatch.Frequency)));
        }

        internal string? Process(JObject? message, int roomId)
        {
            if (message is null || roomId <= 0) return null;
            lock (this.gate)
            {
                if (this.currentRoom != roomId)
                {
                    this.activities.Clear();
                    this.currentRoom = roomId;
                }
                var now = this.clock();
                var expired = new List<string>();
                foreach (var pair in this.activities)
                    if (pair.Value.Expires <= now) expired.Add(pair.Key);
                foreach (var key in expired) this.activities.Remove(key);

                var cmd = String(message["cmd"]);
                if (cmd is null) return null;
                var data = message["data"] as JObject;
                if (!MatchesRoom(message, roomId) || (data != null && !MatchesRoom(data, roomId))) return null;
                if (cmd == "PREPARING" || cmd == "LIVE")
                {
                    this.activities.Clear();
                    return null;
                }

                string? kind = null;
                string? id = null;
                long start = 0, end = 0, serverNow = 0;
                if (cmd == "ANCHOR_LOT_START" && data != null)
                {
                    if (Integer(data["room_id"]) != roomId) return null;
                    kind = "anchor";
                    id = Id(data["id"]);
                    start = serverNow = Seconds(data["current_time"]);
                    var seconds = Integer(data["time"]);
                    if (seconds > 0 && seconds <= MaxLifetimeMs / 1000) end = start + seconds * 1000;
                }
                else if (cmd == "POPULARITY_RED_POCKET_START" && data != null)
                {
                    kind = "red-pocket";
                    id = Id(data["lot_id"]);
                    start = Seconds(data["start_time"]);
                    end = Seconds(data["end_time"]);
                    serverNow = Seconds(data["current_time"]);
                }
                else if ((cmd == "ANCHOR_LOT_END" || cmd == "ANCHOR_LOT_AWARD" || cmd == "POPULARITY_RED_POCKET_WINNER_LIST") && data != null)
                {
                    kind = cmd == "POPULARITY_RED_POCKET_WINNER_LIST" ? "red-pocket" : "anchor";
                    id = Id(data[kind == "anchor" ? "id" : "lot_id"]);
                    if (id != null)
                    {
                        var key = kind + ":" + id;
                        // Keep a bounded tombstone so a delayed START cannot reopen an ended activity.
                        if (this.activities.ContainsKey(key) || this.activities.Count < MaxActivities)
                            this.activities[key] = new Activity { Closed = true, Expires = now + MaxLifetimeMs };
                    }
                    return null;
                }

                if (kind != null)
                {
                    var phrase = String(data?["danmu"]);
                    if (id is null || string.IsNullOrWhiteSpace(phrase) || phrase!.Length > 1024 || start <= 0 || serverNow <= 0 || end <= start || end <= serverNow || end - start > MaxLifetimeMs || end - serverNow > MaxLifetimeMs) return null;
                    var key = kind + ":" + id;
                    if (this.activities.TryGetValue(key, out var previous) && previous.Closed) return null;
                    if (previous is null && this.activities.Count >= MaxActivities) return null;
                    this.activities[key] = new Activity { Text = phrase, Start = start, End = end, Expires = now + (end - serverNow) };
                    return null;
                }

                if (cmd != "DANMU_MSG" && !cmd.StartsWith("DANMU_MSG:", StringComparison.Ordinal)) return null;
                var info = message["info"] as JArray;
                var properties = info != null && info.Count > 0 ? info[0] as JArray : null;
                var text = info != null && info.Count > 1 ? String(info[1]) : null;
                var stamp = properties != null && properties.Count > 4 ? Integer(properties[4]) : 0;
                // The historical protocol also used Unix seconds. Never substitute receipt time.
                if (stamp >= 1000000000L && stamp <= 9999999999L) stamp *= 1000;
                if (text is null || stamp < 1000000000000L || stamp > 9999999999999L) return null;
                foreach (var pair in this.activities)
                {
                    var activity = pair.Value;
                    if (!activity.Closed && stamp >= activity.Start && stamp < activity.End && string.Equals(text, activity.Text, StringComparison.Ordinal))
                        return pair.Key;
                }
                return null;
            }
        }

        private static bool MatchesRoom(JObject obj, int roomId)
        {
            foreach (var name in new[] { "room_id", "roomid", "_roomid" })
                if (obj.TryGetValue(name, out var value) && Integer(value) != roomId) return false;
            return true;
        }

        private static string? String(JToken? token) => token?.Type == JTokenType.String ? token.Value<string>() : null;
        private static long Integer(JToken? token) => token?.Type == JTokenType.Integer && long.TryParse(token.ToString(), NumberStyles.None, CultureInfo.InvariantCulture, out var value) ? value : 0;
        private static long Seconds(JToken? token) { var value = Integer(token); return value >= 1000000000L && value <= 9999999999L ? value * 1000 : 0; }
        private static string? Id(JToken? token) { var value = Integer(token); return value > 0 && value <= 9007199254740991L ? value.ToString(CultureInfo.InvariantCulture) : null; }
    }
}