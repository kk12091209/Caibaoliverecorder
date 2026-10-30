using System.Linq;
using System.Xml.Linq;
using BililiveRecorder.Core.Api.Danmaku;
using BililiveRecorder.Core.Danmaku;
using Newtonsoft.Json.Linq;
using Xunit;

namespace BililiveRecorder.Core.UnitTests.Danmaku
{
    public class GiftEventXmlTests
    {
        [Fact]
        public void PaidGiftSnapshotsOnlyRequiredFieldsAndEscapesText()
        {
            var value = new JObject { ["cmd"] = "SEND_GIFT", ["data"] = new JObject {
                ["uname"] = "用户<&", ["uid"] = 8, ["giftId"] = 1, ["giftName"] = "鲜花<&", ["num"] = 2,
                ["price"] = 1000, ["total_coin"] = 2000, ["coin_type"] = "gold", ["profile"] = new string('x', 50000) } };
            var xml = GiftEventXml.Create(new DanmakuModel(value.ToString()), 12.345).Single();
            var element = XElement.Parse(xml);
            Assert.Equal("12.345", element.Attribute("ts")?.Value);
            Assert.Equal("用户<&", element.Attribute("user")?.Value);
            Assert.Equal("鲜花<&", element.Attribute("giftname")?.Value);
            Assert.Equal("2000", element.Attribute("total_coin")?.Value);
            Assert.DoesNotContain("profile", xml);
            Assert.True(xml.Length < 1000);
        }
        [Fact]
        public void GuardKeepsLevelAndActualSinglePurchaseQuoteWithoutHardcodedPrice()
        {
            var value = new JObject { ["cmd"] = "GUARD_BUY", ["data"] = new JObject {
                ["username"] = "舰长用户", ["uid"] = 9, ["guard_level"] = 3, ["num"] = 1, ["price"] = 138000, ["gift_id"] = 10003 } };
            var element = XElement.Parse(GiftEventXml.Create(new DanmakuModel(value.ToString()), 3).Single());
            Assert.Equal("guard", element.Name.LocalName);
            Assert.Equal("舰长", element.Attribute("giftname")?.Value);
            Assert.Equal("138000", element.Attribute("total_coin")?.Value);
            ((JObject)value["data"]!)["num"] = 3;
            element = XElement.Parse(GiftEventXml.Create(new DanmakuModel(value.ToString()), 3).Single());
            Assert.Null(element.Attribute("total_coin"));
        }
    }
}
