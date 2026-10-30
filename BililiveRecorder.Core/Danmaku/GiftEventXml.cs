using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Xml;
using BililiveRecorder.Core.Api.Danmaku;
using Newtonsoft.Json.Linq;

#nullable enable
namespace BililiveRecorder.Core.Danmaku
{
    // Freeze a small event at receipt. Profiles, animation data and raw protocol
    // objects must not remain in the bounded recording queue.
    internal static class GiftEventXml
    {
        internal static IEnumerable<string> Create(DanmakuModel model, double time)
        {
            if (model.MsgType == DanmakuMsgType.GuardBuy)
                yield return Write(model, time, null, true);
            else if (model.GiftList is { } gifts)
            {
                foreach (var gift in gifts) yield return Write(model, time, gift, false);
            }
            else yield return Write(model, time, null, false);
        }
        private static string Clip(string? value, int maximum) => value is null ? string.Empty : BasicDanmakuWriter.RemoveInvalidXMLChars(value.Length > maximum ? value.Substring(0, maximum) : value);
        private static long? Number(JToken? token) => long.TryParse(token?.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) && value >= 0 ? value : null;
        private static string Write(DanmakuModel model, double time, SendGiftV2GiftItem? gift, bool guard)
        {
            var count = gift?.Num ?? model.GiftCount;
            if (count < 1 || count > 1000000000 || double.IsNaN(time) || double.IsInfinity(time) || time < 0) return string.Empty;
            var data = model.RawObject?["data"];
            var id = gift?.GiftId ?? Number(data?["giftId"] ?? data?["gift_id"]);
            var coin = gift?.CoinType ?? data?["coin_type"]?.ToString() ?? (guard ? "gold" : string.Empty);
            long? unit = gift is null ? (guard ? null : Number(data?["price"])) : gift.HasPrice ? gift.Price : null;
            long? total = gift is null ? Number(data?["total_coin"]) : gift.HasTotalCoin && gift.TotalCoin > 0 ? gift.TotalCoin : null;
            if (guard && total is null && count == 1) total = Number(data?["price"]);
            var text = new StringBuilder();
            using (var writer = XmlWriter.Create(new StringWriter(text, CultureInfo.InvariantCulture), new XmlWriterSettings { OmitXmlDeclaration = true, ConformanceLevel = ConformanceLevel.Fragment }))
            {
                void Attr(string name, string? value) { if (!string.IsNullOrEmpty(value)) writer.WriteAttributeString(name, value); }
                writer.WriteStartElement(guard ? "guard" : "gift");
                Attr("ts", time.ToString("F3", CultureInfo.InvariantCulture));
                Attr("user", Clip(model.UserName, 200));
                Attr("uid", model.UserID.ToString(CultureInfo.InvariantCulture));
                Attr("giftid", id?.ToString(CultureInfo.InvariantCulture));
                Attr("giftname", Clip(gift?.GiftName ?? model.GiftName, 200));
                Attr("giftcount", count.ToString(CultureInfo.InvariantCulture));
                if (guard) Attr("level", model.UserGuardLevel.ToString(CultureInfo.InvariantCulture));
                Attr("coin_type", coin is "gold" or "silver" ? coin : null);
                Attr("unit_coin", unit?.ToString(CultureInfo.InvariantCulture));
                Attr("total_coin", total?.ToString(CultureInfo.InvariantCulture));
                Attr("icon", Clip((data?["gift_info"]?["img_basic"] ?? data?["img_basic"])?.ToString(), 2048));
                var eventId = data?["tid"]?.ToString() ?? data?["msg_id"]?.ToString();
                if (!string.IsNullOrEmpty(eventId) && eventId.Length < 100) Attr("eventid", eventId + ":" + id);
                writer.WriteEndElement();
            }
            return text.ToString();
        }
    }
}
