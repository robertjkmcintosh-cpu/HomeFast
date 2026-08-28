// Netlify Function: nextbus
// Proxies requests to the TfNSW Trip Planner API so the API key never
// appears in the browser. Called by the app as:
//   /.netlify/functions/nextbus?lat=-33.87&lon=151.19
//
// Requires an environment variable set in the Netlify dashboard:
//   TFNSW_API_KEY = <your key from opendata.transport.nsw.gov.au>

const TFNSW_BASE = "https://api.transport.nsw.gov.au/v1/tp/";

exports.handler = async (event) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  try {
    const apiKey = process.env.TFNSW_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Missing TFNSW_API_KEY. Add it in Netlify: Site settings → Environment variables."
        })
      };
    }

    const { lat, lon } = event.queryStringParameters || {};
    if (!lat || !lon) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "lat and lon query parameters are required." })
      };
    }

    const authHeader = { Authorization: `apikey ${apiKey}` };

    // 1. Find the nearest stop to the given coordinates.
    const stopFinderUrl =
      `${TFNSW_BASE}stop_finder?outputFormat=rapidJSON&type_sf=coord` +
      `&name_sf=${encodeURIComponent(lon)}:${encodeURIComponent(lat)}:EPSG:4326` +
      `&coordOutputFormat=EPSG:4326&TfNSWSF=true`;

    const stopRes = await fetch(stopFinderUrl, { headers: authHeader });
    if (!stopRes.ok) {
      const text = await stopRes.text();
      return {
        statusCode: stopRes.status,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Stop lookup failed", detail: text.slice(0, 500) })
      };
    }
    const stopData = await stopRes.json();

    const stopLocations = (stopData.locations || []).filter(
      (l) => l.type === "stop" || l.type === "platform"
    );
    const nearestStop = stopLocations[0] || (stopData.locations || [])[0];

    if (!nearestStop) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: "No public transport stop found near that location." })
      };
    }

    // 2. Get live departures for that stop.
    const now = new Date();
    const itdDate = now.toISOString().slice(0, 10).replace(/-/g, "");
    const itdTime =
      String(now.getHours()).padStart(2, "0") + String(now.getMinutes()).padStart(2, "0");

    const departureUrl =
      `${TFNSW_BASE}departure_mon?outputFormat=rapidJSON&coordOutputFormat=EPSG:4326` +
      `&mode=direct&type_dm=stop&name_dm=${encodeURIComponent(nearestStop.id)}` +
      `&depArrMacro=dep&itdDate=${itdDate}&itdTime=${itdTime}&TfNSWDM=true`;

    const depRes = await fetch(departureUrl, { headers: authHeader });
    if (!depRes.ok) {
      const text = await depRes.text();
      return {
        statusCode: depRes.status,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Departure lookup failed", detail: text.slice(0, 500) })
      };
    }
    const depData = await depRes.json();

    const departures = (depData.stopEvents || []).slice(0, 8).map((se) => {
      const transportation = se.transportation || {};
      const plannedTime = se.departureTimePlanned;
      const estimatedTime = se.departureTimeEstimated || plannedTime;
      const minutes = estimatedTime
        ? Math.round((new Date(estimatedTime).getTime() - Date.now()) / 60000)
        : null;

      const loc = se.location || {};
      const platform =
        loc.disassembledName || loc.name || (loc.parent && loc.parent.disassembledName) || "";

      return {
        line: transportation.number || transportation.disassembledName || "?",
        mode: (transportation.product && transportation.product.name) || "Service",
        destination: (transportation.destination && transportation.destination.name) || "",
        minutes,
        departureTime: estimatedTime || plannedTime || null,
        platform,
        realtime: !!se.isRealtimeControlled
      };
    });

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        stopName: nearestStop.name || nearestStop.disassembledName || "Nearby stop",
        stopCoord: Array.isArray(nearestStop.coord) ? nearestStop.coord : null,
        departures
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Unexpected error", detail: String(err) })
    };
  }
};
