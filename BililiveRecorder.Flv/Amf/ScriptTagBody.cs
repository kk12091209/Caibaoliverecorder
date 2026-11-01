using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Xml;
using System.Xml.Schema;
using System.Xml.Serialization;
using BililiveRecorder.Flv.Parser;
using Newtonsoft.Json;

namespace BililiveRecorder.Flv.Amf
{
    public class ScriptTagBody : IXmlSerializable
    {
        private static readonly JsonSerializerSettings jsonSerializerSettings = new JsonSerializerSettings
        {
            DateParseHandling = DateParseHandling.DateTimeOffset,
            DateFormatHandling = DateFormatHandling.IsoDateFormat,
            DateTimeZoneHandling = DateTimeZoneHandling.RoundtripKind,
        };

        public ScriptTagBody()
        {
            this.Values = new List<IScriptDataValue>();
        }

        public ScriptTagBody(List<IScriptDataValue> values)
        {
            this.Values = values ?? throw new ArgumentNullException(nameof(values));
        }

        public List<IScriptDataValue> Values { get; set; }

        public static ScriptTagBody Parse(string json) =>
            new ScriptTagBody(JsonConvert.DeserializeObject<List<IScriptDataValue>>(json, jsonSerializerSettings)
                ?? throw new Exception("JsonConvert.DeserializeObject returned null"));

        public string ToJson() => JsonConvert.SerializeObject(this.Values, jsonSerializerSettings);

        public static ScriptTagBody Parse(byte[] bytes)
        {
            using var ms = new MemoryStream(bytes);
            return Parse(ms);
        }

        public static ScriptTagBody Parse(Stream stream) => Parse(new BigEndianBinaryReader(stream, Encoding.UTF8, true));

        public static ScriptTagBody Parse(BigEndianBinaryReader binaryReader)
        {
            var list = new List<IScriptDataValue>();
            var budget = new ParseBudget();

            while (binaryReader.BaseStream.Position < binaryReader.BaseStream.Length)
                list.Add(ParseValue(binaryReader, budget, 0));

            return new ScriptTagBody(list);
        }

        public byte[] ToBytes()
        {
            using var ms = new MemoryStream();
            this.WriteTo(ms);
            return ms.ToArray();
        }

        public void WriteTo(Stream stream)
        {
            foreach (var value in this.Values)
            {
                value.WriteTo(stream);
            }
        }

        private sealed class ParseBudget
        {
            // Includes recorder-written keyframe metadata (>12,600 values).
            private int bytesLeft = 16 * 1024 * 1024;
            public int NodesLeft { get; private set; } = 100000;
            public void Value(int depth)
            {
                if (depth > 64 || NodesLeft-- <= 0) throw new AmfException("AMF nesting or value count exceeds the parsing limit.");
            }
            public void Bytes(BigEndianBinaryReader reader, long count)
            {
                if (count < 0 || count > bytesLeft) throw new AmfException("AMF data exceeds the parsing byte limit.");
                var stream = reader.BaseStream;
                if (stream.CanSeek && count > stream.Length - stream.Position) throw new AmfException("AMF data is truncated.");
                bytesLeft -= (int)count;
            }
            public byte[] ReadBytes(BigEndianBinaryReader reader, uint count)
            {
                Bytes(reader, count);
                var value = reader.ReadBytes((int)count);
                if (value.Length != count) throw new AmfException("AMF string is truncated.");
                return value;
            }
        }

        public static IScriptDataValue ParseValue(BigEndianBinaryReader binaryReader) => ParseValue(binaryReader, new ParseBudget(), 0);

        private static IScriptDataValue ParseValue(BigEndianBinaryReader binaryReader, ParseBudget budget, int depth)
        {
            budget.Value(depth);
            budget.Bytes(binaryReader, 1);
            var type = (ScriptDataType)binaryReader.ReadByte();
            switch (type)
            {
                case ScriptDataType.Number:
                    budget.Bytes(binaryReader, 8);
                    return (ScriptDataNumber)binaryReader.ReadDouble();
                case ScriptDataType.Boolean:
                    budget.Bytes(binaryReader, 1);
                    return (ScriptDataBoolean)binaryReader.ReadBoolean();
                case ScriptDataType.String:
                    return ReadScriptDataString(binaryReader, budget, false) ?? string.Empty;
                case ScriptDataType.Object:
                    {
                        var result = new ScriptDataObject();
                        while (true)
                        {
                            var propertyName = ReadScriptDataString(binaryReader, budget, true);
                            if (propertyName is null)
                                break;

                            var propertyData = ParseValue(binaryReader, budget, depth + 1);

                            result[propertyName] = propertyData;
                        }
                        return result;
                    }
                case ScriptDataType.MovieClip:
                    throw new AmfException("MovieClip is not supported");
                case ScriptDataType.Null:
                    return new ScriptDataNull();
                case ScriptDataType.Undefined:
                    return new ScriptDataUndefined();
                case ScriptDataType.Reference:
                    budget.Bytes(binaryReader, 2);
                    return (ScriptDataReference)binaryReader.ReadUInt16();
                case ScriptDataType.EcmaArray:
                    {
                        budget.Bytes(binaryReader, 4);
                        binaryReader.ReadUInt32();
                        var result = new ScriptDataEcmaArray();
                        while (true)
                        {
                            var propertyName = ReadScriptDataString(binaryReader, budget, true);
                            if (propertyName is null)
                                break;

                            var propertyData = ParseValue(binaryReader, budget, depth + 1);

                            result[propertyName] = propertyData;
                        }
                        return result;
                    }
                case ScriptDataType.ObjectEndMarker:
                    throw new AmfException("Read ObjectEndMarker");
                case ScriptDataType.StrictArray:
                    {
                        budget.Bytes(binaryReader, 4);
                        var length = binaryReader.ReadUInt32();
                        if (length > budget.NodesLeft) throw new AmfException("AMF array exceeds the value count limit.");
                        var result = new ScriptDataStrictArray();
                        for (var i = 0; i < length; i++)
                        {
                            var value = ParseValue(binaryReader, budget, depth + 1);
                            result.Add(value);
                        }
                        return result;
                    }
                case ScriptDataType.Date:
                    {
                        budget.Bytes(binaryReader, 10);
                        var dateTime = binaryReader.ReadDouble();
                        var offset = binaryReader.ReadInt16();
                        return new ScriptDataDate(dateTime, offset);
                    }
                case ScriptDataType.LongString:
                    {
                        budget.Bytes(binaryReader, 4);
                        var length = binaryReader.ReadUInt32();
                        var bytes = budget.ReadBytes(binaryReader, length);
                        return (ScriptDataLongString)Encoding.UTF8.GetString(bytes).Replace("\0", "");
                    }
                default:
                    throw new AmfException("Unknown ScriptDataValueType");
            }

            static ScriptDataString? ReadScriptDataString(BigEndianBinaryReader binaryReader, ParseBudget budget, bool expectObjectEndMarker)
            {
                budget.Bytes(binaryReader, 2);
                var length = binaryReader.ReadUInt16();
                if (length == 0)
                {
                    if (expectObjectEndMarker)
                    {
                        budget.Bytes(binaryReader, 1);
                        if (binaryReader.ReadByte() != 9) throw new AmfException("ObjectEndMarker not matched.");
                    }
                    return null;
                }
                return Encoding.UTF8.GetString(budget.ReadBytes(binaryReader, length)).Replace("\0", "");
            }
        }

        XmlSchema IXmlSerializable.GetSchema() => null!;
        void IXmlSerializable.ReadXml(XmlReader reader)
        {
            var str = reader.ReadElementContentAsString();
            var obj = Parse(str);
            this.Values = obj.Values;
        }
        void IXmlSerializable.WriteXml(XmlWriter writer) => writer.WriteString(this.ToJson());
    }
}
