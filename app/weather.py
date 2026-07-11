"""
Historical weather via Open-Meteo's free archive API — no API key required.
Docs: https://open-meteo.com/en/docs/historical-weather-api
"""
import requests
from datetime import datetime

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"


def get_historical_weather(lat: float, lon: float, date: str, hour: int):
    """
    date: "YYYY-MM-DD"
    hour: 0-23 local hour the run started
    Returns (temp_f, condition_string) or (None, None) on failure.
    """
    if lat is None or lon is None:
        return None, None
    try:
        resp = requests.get(
            ARCHIVE_URL,
            params={
                "latitude": lat,
                "longitude": lon,
                "start_date": date,
                "end_date": date,
                "hourly": "temperature_2m,weathercode",
                "temperature_unit": "fahrenheit",
                "timezone": "auto",
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        hourly = data.get("hourly", {})
        temps = hourly.get("temperature_2m", [])
        codes = hourly.get("weathercode", [])
        if not temps or hour >= len(temps):
            return None, None
        temp_f = temps[hour]
        condition = _weathercode_to_text(codes[hour] if hour < len(codes) else None)
        return round(temp_f, 1), condition
    except Exception:
        return None, None


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
