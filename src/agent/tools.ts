import { tool } from "langchain";
import { z } from "zod";
import {
  formatChunksForPrompt,
  retrieveKnowledge,
} from "../rag/knowledgeBase.js";

const FETCH_TIMEOUT_MS = 8000;

export type ToolRuntimeOptions = {
  /** 评测无网模式：不请求外网，返回稳定桩数据 */
  dryTools?: boolean;
};

const fetchJson = async <T>(
  url: string,
  init?: RequestInit,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    // AbortController 超时会抛 AbortError，转成可读错误便于排查
    if (
      error instanceof Error &&
      (error.name === "AbortError" || /abor(t|ted)/i.test(error.message))
    ) {
      throw new Error(`请求超时（${FETCH_TIMEOUT_MS}ms）：${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

/** BigDataCloud 偶发繁体，统一成简体常用字以便城市匹配 */
const toSimplifiedCity = (name: string): string =>
  name
    .replace(/島/g, "岛")
    .replace(/東/g, "东")
    .replace(/門/g, "门")
    .replace(/灣/g, "湾")
    .replace(/縣/g, "县")
    .replace(/區/g, "区")
    .replace(/廣/g, "广")
    .replace(/寧/g, "宁")
    .replace(/陝/g, "陕")
    .replace(/雲/g, "云")
    .replace(/貴/g, "贵")
    .replace(/龍/g, "龙")
    .replace(/慶/g, "庆");

const normalizeCityName = (raw: string): string =>
  toSimplifiedCity(raw).replace(/(市|地区|特别行政区)$/u, "") || "当前位置";

type NominatimResult = {
  lat: string;
  lon: string;
  display_name: string;
};

type OpenMeteoGeocodeResult = {
  results?: Array<{
    name?: string;
    latitude?: number;
    longitude?: number;
    admin1?: string;
    admin2?: string;
    country?: string;
  }>;
};

const nominatimUserAgent =
  process.env.NOMINATIM_USER_AGENT?.trim() || "travel-recommend-h5/1.0";

const geocodeWithNominatim = async (
  query: string,
): Promise<{ lat: number; lon: number; displayName: string }> => {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");

  const results = await fetchJson<NominatimResult[]>(url.toString(), {
    headers: {
      "User-Agent": nominatimUserAgent,
      Accept: "application/json",
    },
  });

  const first = results[0];
  if (!first) {
    throw new Error(`未找到位置：${query}`);
  }

  return {
    lat: Number(first.lat),
    lon: Number(first.lon),
    displayName: first.display_name,
  };
};

/** Open-Meteo 地理编码在国内通常比 Nominatim 更可达 */
const geocodeWithOpenMeteo = async (
  query: string,
): Promise<{ lat: number; lon: number; displayName: string }> => {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "zh");
  url.searchParams.set("format", "json");

  const data = await fetchJson<OpenMeteoGeocodeResult>(url.toString());
  const first = data.results?.[0];
  if (
    !first ||
    first.latitude === undefined ||
    first.longitude === undefined ||
    Number.isNaN(first.latitude) ||
    Number.isNaN(first.longitude)
  ) {
    throw new Error(`未找到位置：${query}`);
  }

  const displayName = [first.name, first.admin2, first.admin1, first.country]
    .filter(Boolean)
    .join(", ");

  return {
    lat: first.latitude,
    lon: first.longitude,
    displayName: displayName || query,
  };
};

export const geocodePlace = async (
  query: string,
  options: ToolRuntimeOptions = {},
): Promise<{
  lat: number;
  lon: number;
  displayName: string;
}> => {
  if (options.dryTools) {
    const presets: Record<string, { lat: number; lon: number; displayName: string }> =
      {
        北京: { lat: 39.9042, lon: 116.4074, displayName: "北京市, 中国" },
        上海: { lat: 31.2304, lon: 121.4737, displayName: "上海市, 中国" },
        成都: { lat: 30.5728, lon: 104.0668, displayName: "成都市, 四川省, 中国" },
        杭州: { lat: 30.2741, lon: 120.1551, displayName: "杭州市, 浙江省, 中国" },
        东京: { lat: 35.6762, lon: 139.6503, displayName: "東京都, 日本" },
        西安: { lat: 34.3416, lon: 108.9398, displayName: "西安市, 陕西省, 中国" },
      };
    for (const [key, value] of Object.entries(presets)) {
      if (query.includes(key)) return value;
    }
    return { lat: 39.9, lon: 116.4, displayName: `${query}（模拟坐标）` };
  }

  // 优先 Open-Meteo（国内可达）；Nominatim 常超时，仅作回退
  try {
    return await geocodeWithOpenMeteo(query);
  } catch (primaryError) {
    try {
      return await geocodeWithNominatim(query);
    } catch {
      throw primaryError;
    }
  }
};

type NominatimReverse = {
  display_name?: string;
  address?: {
    city?: string;
    town?: string;
    municipality?: string;
    county?: string;
    state?: string;
    province?: string;
  };
};

type BigDataCloudReverse = {
  city?: string;
  locality?: string;
  principalSubdivision?: string;
  countryName?: string;
};

const reverseGeocodeWithBigDataCloud = async (
  lat: number,
  lon: number,
): Promise<{ city: string; displayName: string }> => {
  const url = new URL(
    "https://api.bigdatacloud.net/data/reverse-geocode-client",
  );
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("localityLanguage", "zh");

  const data = await fetchJson<BigDataCloudReverse>(url.toString());
  const rawCity =
    data.city || data.locality || data.principalSubdivision || "";
  const city = normalizeCityName(rawCity);
  const displayName =
    [data.locality, data.city, data.principalSubdivision, data.countryName]
      .filter(Boolean)
      .map((part) => toSimplifiedCity(String(part)))
      .join(", ") || `${lat}, ${lon}`;

  return { city, displayName };
};

const reverseGeocodeWithNominatim = async (
  lat: number,
  lon: number,
): Promise<{ city: string; displayName: string }> => {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("format", "json");
  url.searchParams.set("zoom", "10");

  const data = await fetchJson<NominatimReverse>(url.toString(), {
    headers: {
      "User-Agent": nominatimUserAgent,
      Accept: "application/json",
    },
  });

  const address = data.address ?? {};
  const rawCity =
    address.city ||
    address.town ||
    address.municipality ||
    address.county ||
    address.state ||
    address.province ||
    "";

  return {
    city: normalizeCityName(rawCity),
    displayName: data.display_name || `${lat}, ${lon}`,
  };
};

/** 坐标反查城市名 */
export const reverseGeocode = async (
  lat: number,
  lon: number,
  options: ToolRuntimeOptions = {},
): Promise<{ city: string; displayName: string }> => {
  if (options.dryTools) {
    return {
      city: "模拟城市",
      displayName: `模拟位置 (${lat.toFixed(4)}, ${lon.toFixed(4)})`,
    };
  }

  // Nominatim 在国内常不可达；优先 BigDataCloud，失败再回退 Nominatim
  try {
    return await reverseGeocodeWithBigDataCloud(lat, lon);
  } catch (primaryError) {
    try {
      return await reverseGeocodeWithNominatim(lat, lon);
    } catch {
      throw primaryError;
    }
  }
};

type OpenMeteoResponse = {
  current?: {
    temperature_2m?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_sum?: number[];
    weather_code?: number[];
  };
};

const weatherCodeLabel = (code?: number): string => {
  if (code === undefined || Number.isNaN(code)) return "未知";
  if (code === 0) return "晴";
  if (code <= 3) return "多云";
  if (code <= 48) return "雾";
  if (code <= 67) return "雨";
  if (code <= 77) return "雪";
  if (code <= 82) return "阵雨";
  if (code <= 86) return "阵雪";
  if (code <= 99) return "雷暴";
  return `天气码 ${code}`;
};

export type WeatherQuery = {
  city?: string;
  lat?: number;
  lon?: number;
  days?: number;
};

export const fetchWeather = async (
  query: WeatherQuery,
  options: ToolRuntimeOptions = {},
) => {
  const safeDays = Math.min(7, Math.max(1, query.days ?? 3));
  let lat = query.lat;
  let lon = query.lon;
  let city = query.city?.trim() || "";
  let displayName = city || "当前位置";

  if (
    (lat === undefined || lon === undefined || Number.isNaN(lat) || Number.isNaN(lon)) &&
    city
  ) {
    const geo = await geocodePlace(city, options);
    lat = geo.lat;
    lon = geo.lon;
    displayName = geo.displayName;
  }

  if (lat === undefined || lon === undefined || Number.isNaN(lat) || Number.isNaN(lon)) {
    throw new Error("查询天气需要城市名或有效经纬度");
  }

  if (!city) {
    try {
      const rev = await reverseGeocode(lat, lon, options);
      city = rev.city;
      displayName = rev.displayName;
    } catch {
      city = "当前位置";
      displayName = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    }
  }

  if (options.dryTools) {
    return {
      city,
      location: displayName,
      lat,
      lon,
      current: {
        temperatureC: 22,
        weather: "多云",
        windSpeed: 3.2,
      },
      daily: Array.from({ length: safeDays }, (_, i) => ({
        date: new Date(Date.now() + i * 86400000).toISOString().slice(0, 10),
        weather: i === 0 ? "多云" : "晴",
        tempMaxC: 26 - i,
        tempMinC: 16 - i,
        precipitationMm: i === 1 ? 2.0 : 0,
      })),
      source: "dry-tools",
    };
  }

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,weather_code,wind_speed_10m");
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum",
  );
  url.searchParams.set("forecast_days", String(safeDays));
  url.searchParams.set("timezone", "auto");

  const data = await fetchJson<OpenMeteoResponse>(url.toString());

  return {
    city,
    location: displayName,
    lat,
    lon,
    current: {
      temperatureC: data.current?.temperature_2m ?? null,
      weather: weatherCodeLabel(data.current?.weather_code),
      windSpeed: data.current?.wind_speed_10m ?? null,
    },
    daily: (data.daily?.time ?? []).map((date, index) => ({
      date,
      weather: weatherCodeLabel(data.daily?.weather_code?.[index]),
      tempMaxC: data.daily?.temperature_2m_max?.[index] ?? null,
      tempMinC: data.daily?.temperature_2m_min?.[index] ?? null,
      precipitationMm: data.daily?.precipitation_sum?.[index] ?? null,
    })),
    source: "open-meteo",
  };
};

const toToolError = (toolName: string, error: unknown): string =>
  JSON.stringify({
    ok: false,
    tool: toolName,
    error: error instanceof Error ? error.message : String(error),
  });

const toToolOk = (payload: unknown): string =>
  JSON.stringify({ ok: true, data: payload });

export const createTravelTools = (options: ToolRuntimeOptions = {}) => {
  const getWeather = tool(
    async ({ city, lat, lon, days }) => {
      try {
        const data = await fetchWeather(
          { city, lat, lon, days: days ?? 3 },
          options,
        );
        return toToolOk(data);
      } catch (error) {
        return toToolError("get_weather", error);
      }
    },
    {
      name: "get_weather",
      description:
        "查询实时天气与未来几日预报。可传城市名，或直接传 lat/lon（用户当前位置优先用坐标）。询问气温、下雨、出行穿衣时调用。",
      schema: z.object({
        city: z
          .string()
          .optional()
          .describe("城市名，如北京、上海；问当前位置时可填定位解析出的城市"),
        lat: z.number().optional().describe("纬度，用户当前位置时可直接传入"),
        lon: z.number().optional().describe("经度，用户当前位置时可直接传入"),
        days: z
          .number()
          .int()
          .min(1)
          .max(7)
          .optional()
          .describe("预报天数，默认 3，最大 7"),
      }),
    },
  );

  const geocodeLocation = tool(
    async ({ query }) => {
      try {
        const data = await geocodePlace(query, options);
        return toToolOk(data);
      } catch (error) {
        return toToolError("geocode_location", error);
      }
    },
    {
      name: "geocode_location",
      description:
        "将地名/地址解析为经纬度与标准地名。用户询问位置、坐标、某地在哪时应调用。",
      schema: z.object({
        query: z.string().describe("地名或地址，如杭州西湖、成都市"),
      }),
    },
  );

  const searchAttractions = tool(
    async ({ city, keyword }) => {
      try {
        const query = [city, keyword, "景点"].filter(Boolean).join(" ");
        const chunks = retrieveKnowledge({
          query,
          city,
          type: "attraction",
          topK: 4,
        });
        if (chunks.length === 0) {
          return toToolOk({ city, keyword: keyword ?? "", results: [], note: "知识库暂无匹配景点" });
        }
        return toToolOk({
          city,
          keyword: keyword ?? "",
          results: chunks.map((c) => ({
            title: c.title,
            city: c.city,
            content: c.content,
            source: c.source,
          })),
        });
      } catch (error) {
        return toToolError("search_attractions", error);
      }
    },
    {
      name: "search_attractions",
      description:
        "从本地景点知识库检索某城市必去景点与介绍。规划行程、问必去景点时调用。",
      schema: z.object({
        city: z.string().describe("城市名"),
        keyword: z
          .string()
          .optional()
          .describe("可选关键词，如博物馆、夜景、亲子"),
      }),
    },
  );

  const searchTravelGuides = tool(
    async ({ query, city }) => {
      try {
        const chunks = retrieveKnowledge({
          query,
          city,
          type: "guide",
          topK: 4,
        });
        if (chunks.length === 0) {
          return toToolOk({
            query,
            city: city ?? "",
            results: [],
            note: "知识库暂无匹配攻略",
          });
        }
        return toToolOk({
          query,
          city: city ?? "",
          resultsText: formatChunksForPrompt(chunks),
          results: chunks.map((c) => ({
            title: c.title,
            city: c.city,
            content: c.content,
            source: c.source,
          })),
        });
      } catch (error) {
        return toToolError("search_travel_guides", error);
      }
    },
    {
      name: "search_travel_guides",
      description:
        "从本地旅游攻略知识库检索交通、美食、行程建议等资料。问攻略、怎么玩、吃什么时调用。",
      schema: z.object({
        query: z.string().describe("检索问题或关键词"),
        city: z.string().optional().describe("可选城市过滤"),
      }),
    },
  );

  return [getWeather, geocodeLocation, searchAttractions, searchTravelGuides];
};
