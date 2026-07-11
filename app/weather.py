"""
Historical weather via Open-Meteo's free archive API — no API key required.
Docs: https://open-meteo.com/en/docs/historical-weather-api
"""
import math
import requests
from datetime import datetime

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"


def get_historical_weather(lat: float, lon: float, date: str, hour: int):
    """
    date: "YYYY-MM-DD"
    hour: 0-23 local hour the run started
    Returns (temp_f, condition_string, heat_index_f, wet_bulb_f), any of which may
    be None on failure or if humidity wasn't available for the derived values.
    """
    if lat is None or lon is None:
        return None, None, None, None
    try:
        resp = requests.get(
            ARCHIVE_URL,
            params={
                "latitude": lat,
                "longitude": lon,
                "start_date": date,
                "end_date": date,
                "hourly": "temperature_2m,relativehumidity_2m,weathercode",
                "temperature_unit": "fahrenheit",
                "timezone": "auto",
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        hourly = data.get("hourly", {})
        temps = hourly.get("temperature_2m", [])
        humidity = hourly.get("relativehumidity_2m", [])
        codes = hourly.get("weathercode", [])
        if not temps or hour >= len(temps):
            return None, None, None, None
        temp_f = temps[hour]
        condition = _weathercode_to_text(codes[hour] if hour < len(codes) else None)
        rh = humidity[hour] if humidity and hour < len(humidity) else None
        heat_index_f = _heat_index_f(temp_f, rh) if rh is not None else None
        wet_bulb_f = _wet_bulb_f(temp_f, rh) if rh is not None else None
        return (
            round(temp_f, 1),
            condition,
            round(heat_index_f, 1) if heat_index_f is not None else None,
            round(wet_bulb_f, 1) if wet_bulb_f is not None else None,
        )
    except Exception:
        return None, None, None, None


def _heat_index_f(temp_f: float, rh: float):
    """NWS Rothfusz regression. Below 80F/40%RH the heat index is essentially
    just the air temp, so the regression (which is only fit for hot/humid
    conditions) is skipped in favor of returning temp_f unchanged."""
    if temp_f < 80 or rh < 40:
        return temp_f
    t, r = temp_f, rh
    hi = (
        -42.379 + 2.04901523 * t + 10.14333127 * r - 0.22475541 * t * r
        - 0.00683783 * t * t - 0.05481717 * r * r
        + 0.00122874 * t * t * r + 0.00085282 * t * r * r
        - 0.00000199 * t * t * r * r
    )
    return hi


def _wet_bulb_f(temp_f: float, rh: float):
    """Stull (2011) approximation, computed in Celsius then converted back."""
    t_c = (temp_f - 32) * 5 / 9
    tw_c = (
        t_c * math.atan(0.151977 * math.sqrt(rh + 8.313659))
        + math.atan(t_c + rh) - math.atan(rh - 1.676331)
        + 0.00391838 * (rh ** 1.5) * math.atan(0.023101 * rh)
        - 4.686035
    )
    return tw_c * 9 / 5 + 32


def _weathercode_to_text(code):
    """WMO weather interpretation codes, simplified."""
    if code is None:
        return None
    mapping = {
        0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
        45: "Fog", 48: "Fog",
        51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
        61: "Light rain", 63: "Rain", 65: "Heavy rain",
        71: "Light snow", 73: "Snow", 75: "Heavy snow",
        80: "Rain showers", 81: "Rain showers", 82: "Violent rain showers",
        95: "Thunderstorm", 96: "Thunderstorm w/ hail", 99: "Thunderstorm w/ hail",
    }
    return mapping.get(code, "Unknown")
