const TTL = 6 * 60 * 60 * 1000;
let cache;

function latestCSV(text) {
  const rows = text
    .trim()
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .slice(1);

  for (let i = rows.length - 1; i >= 0; i--) {
    const [date, raw] = rows[i].replaceAll('"', "").split(",");

    if (
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      raw?.trim() &&
      raw !== "." &&
      Number.isFinite(Number(raw)) &&
      Number(raw) >= 0
    ) {
      return { value: Number(raw), date };
    }
  }

  throw new Error("No valid observation in CSV");
}

async function get(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: {
      Accept: "text/csv,text/html;q=0.9,*/*;q=0.8"
    }
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }

  return response.text();
}

function parsePMMS(html) {
  const clean = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/\s+/g, " ");

  const observation = clean.match(
    /(?:weekly mortgage rate averages as of|as of)\s+(\d{1,2}\/\d{1,2}\/20\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2})/i
  );

  const dateText =
    observation?.[1] ||
    clean.match(
      /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}/
    )?.[0];

  const nearby = observation
    ? clean.slice(observation.index, observation.index + 1500)
    : clean;

  const rate = nearby.match(
    /30[-\s]?Year(?:\s+Fixed(?:[-\s]Rate)?)?[^%]{0,100}?((?:[2-9]|1[0-9])\.\d{1,2})\s*%/i
  );

  const date = new Date(dateText);

  if (rate && !Number.isNaN(date.getTime())) {
    return {
      value: Number(rate[1]),
      date: date.toISOString().slice(0, 10)
    };
  }

  throw new Error("Could not identify dated Freddie Mac rate");
}

export async function handler(event) {
  const debug = Object.hasOwn(
    event.queryStringParameters || {},
    "debug"
  );

  const now = Date.now();

  const cacheHit =
    Boolean(cache) &&
    now - cache.at <
      (cache.mortgage && cache.treasury ? TTL : 60000);

  if (!cacheHit) {
    const errors = [];

    async function mortgage() {
      try {
        const observation = latestCSV(
          await get(
            "https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US"
          )
        );

        return {
          ...observation,
          source: "Freddie Mac PMMS via FRED MORTGAGE30US",
          sample: false
        };
      } catch (error) {
        errors.push({
          source: "MORTGAGE30US",
          error: error.message
        });
      }

      try {
        const observation = parsePMMS(
          await get("https://www.freddiemac.com/pmms")
        );

        return {
          ...observation,
          source: "Freddie Mac PMMS website",
          sample: false
        };
      } catch (error) {
        errors.push({
          source: "Freddie Mac PMMS website",
          error: error.message
        });

        return null;
      }
    }

    async function treasury() {
      try {
        const observation = latestCSV(
          await get(
            "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10"
          )
        );

        return {
          ...observation,
          source: "10-year Treasury via FRED DGS10",
          sample: false
        };
      } catch (error) {
        errors.push({
          source: "DGS10",
          error: error.message
        });

        return null;
      }
    }

    const [mortgageRate, treasuryRate] = await Promise.all([
      mortgage(),
      treasury()
    ]);

    cache = {
      at: now,
      mortgage: mortgageRate,
      treasury: treasuryRate,
      errors
    };
  }

  const success = Boolean(cache.mortgage && cache.treasury);

  const result = {
    mortgage: cache.mortgage,
    treasury: cache.treasury,
    fetchedAt: new Date(cache.at).toISOString(),
    cacheSeconds: TTL / 1000
  };

  if (debug) {
    result.debug = {
      cacheHit,
      ageSeconds: Math.floor((now - cache.at) / 1000),
      errors: cache.errors
    };
  }

  return {
    statusCode: success ? 200 : 503,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control":
        debug || !success
          ? "no-store"
          : "public, max-age=21600"
    },
    body: JSON.stringify(result)
  };
}
