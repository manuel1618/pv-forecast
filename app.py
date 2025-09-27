import logging
from typing import Any, Dict, List

import numpy as np
import openmeteo_requests
import pandas as pd
import requests_cache
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from geopy.geocoders import Nominatim
from pydantic import BaseModel, Field
from retry_requests import retry

# Configure logging for production
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)

# --- App Setup ---
app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

# --- API Client Setup ---
cache_session = requests_cache.CachedSession(".cache", expire_after=3600)
retry_session = retry(cache_session, retries=5, backoff_factor=0.2)
openmeteo = openmeteo_requests.Client(session=retry_session)

# --- Geocoding ---
geolocator = Nominatim(user_agent="pv_forecast_calculator")


# --- Models ---
class PVSystem(BaseModel):
    power: float = Field(..., gt=0, description="Peak power of the PV system in kWp")
    inclination: float = Field(
        ..., ge=0, le=90, description="Inclination angle of the panels in degrees"
    )
    azimuth: float = Field(
        ...,
        ge=-180,
        le=180,
        description="Azimuth angle of the panels in degrees (South=0, East=90, West=-90)",
    )
    module_efficiency: float = Field(
        default=0.18,
        ge=0.1,
        le=0.25,
        description="Module efficiency at STC (0.18 = 18%)",
    )
    temperature_coefficient: float = Field(
        default=-0.0035, ge=-0.01, le=0, description="Temperature coefficient in /°C"
    )
    noct: float = Field(
        default=45.0,
        ge=40,
        le=50,
        description="Nominal Operating Cell Temperature in °C",
    )
    system_losses: float = Field(
        default=0.14, ge=0.05, le=0.25, description="Total system losses (0.14 = 14%)"
    )


class ForecastRequest(BaseModel):
    address: str = Field(..., min_length=3, description="The address for the forecast")
    pv_systems: List[PVSystem] = Field(..., max_items=3)


# --- Advanced PV Calculation Constants ---
STC_TEMPERATURE = 25.0  # Standard Test Conditions temperature in °C
STC_IRRADIANCE = 1000.0  # Standard Test Conditions irradiance in W/m²


def calculate_advanced_pv_energy(
    irradiance: np.ndarray, ambient_temp: np.ndarray, system: PVSystem
) -> np.ndarray:
    """
    Advanced PV energy calculation following the 5-step model:
    1. Get POA irradiance (input)
    2. Estimate module cell temperature
    3. Correct module efficiency for temperature
    4. Calculate energy per time step
    5. Sum for daily total (handled by caller)
    """
    # Step 1: POA irradiance is already provided as input

    # Step 2: Estimate module cell temperature
    # T_c = T_a + ((NOCT - 20) / 800) * I_POA
    cell_temperature = ambient_temp + ((system.noct - 20) / 800) * irradiance

    # Step 3: Correct module efficiency for temperature
    # η_mod,eff = η_STC * (1 + γ * (T_c - 25))
    module_efficiency = system.module_efficiency * (
        1 + system.temperature_coefficient * (cell_temperature - STC_TEMPERATURE)
    )

    # Step 4: Calculate energy per time step (1 hour)
    # E_step = (I_POA * A_mod * η_mod,eff * (1 - L) / 1000) * Δt
    # Where A_mod = P_rated / (η_STC * 1000) and Δt = 1 hour

    # Calculate module area from rated power and efficiency
    module_area = (system.power * 1000) / (system.module_efficiency * STC_IRRADIANCE)

    # Calculate hourly energy in kWh
    hourly_energy = (
        irradiance * module_area * module_efficiency * (1 - system.system_losses) / 1000
    )

    return hourly_energy


@app.get("/")
async def read_root():
    return FileResponse("static/index.html")


@app.get("/api/geocode")
async def geocode_address(query: str) -> Dict[str, List[Dict[str, Any]]]:
    """Get address suggestions for autocomplete"""
    if len(query.strip()) < 3:
        return {"suggestions": []}

    try:
        # Use geopy to get multiple suggestions
        locations = geolocator.geocode(query, exactly_one=False, limit=5)

        if not locations:
            return {"suggestions": []}

        suggestions = [
            {
                "address": location.address,
                "latitude": location.latitude,
                "longitude": location.longitude,
            }
            for location in locations
        ]

        return {"suggestions": suggestions}

    except Exception as e:
        logger.error(f"Geocoding error for query '{query}': {str(e)}")
        return {"suggestions": []}


@app.post("/api/forecast")
async def get_pv_forecast(request: ForecastRequest) -> Dict[str, Any]:
    try:
        location = geolocator.geocode(request.address)
        if not location:
            raise HTTPException(
                status_code=404,
                detail=f"Address not found: '{request.address}'. Please try a more specific address.",
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Geocoding error for address '{request.address}': {str(e)}")
        raise HTTPException(status_code=500, detail=f"Geocoding failed: {str(e)}")

    latitude = location.latitude
    longitude = location.longitude

    total_hourly_kwh = pd.Series([0.0] * 168)  # 7 days * 24 hours

    for system in request.pv_systems:
        # API call for each system due to unique tilt/azimuth
        url = "https://api.open-meteo.com/v1/forecast"
        params = {
            "latitude": latitude,
            "longitude": longitude,
            "hourly": "global_tilted_irradiance,temperature_2m",
            "forecast_days": 7,  # Get 7 days of forecast data
            "tilt": system.inclination,
            "azimuth": system.azimuth,
        }

        try:
            responses = openmeteo.weather_api(url, params=params)
            response = responses[0]

            hourly = response.Hourly()
            irradiance = hourly.Variables(0).ValuesAsNumpy()  # POA irradiance in W/m²
            ambient_temp = hourly.Variables(
                1
            ).ValuesAsNumpy()  # Ambient temperature in °C

            # Advanced PV calculation following the 5-step model
            hourly_kwh = calculate_advanced_pv_energy(irradiance, ambient_temp, system)

            # Ensure the series has the correct number of data points (7 days * 24 hours)
            series_kwh = pd.Series(hourly_kwh).reindex(
                range(168), fill_value=0.0
            )  # 7 days * 24 hours
            total_hourly_kwh += series_kwh

        except Exception as e:
            logger.error(f"Failed to process PV system: {system}. Error: {e}")
            # Continue if one system fails, but log it. Or raise an error.
            # For now, we'll be robust and just skip the failing system.
            continue

    # Calculate daily totals for each day
    daily_totals = []
    for day in range(7):
        start_hour = day * 24
        end_hour = start_hour + 24
        daily_kwh = total_hourly_kwh[start_hour:end_hour].sum()
        daily_totals.append(round(daily_kwh, 2))

    return {
        "latitude": latitude,
        "longitude": longitude,
        "hourly_forecast_kwh": total_hourly_kwh.round(2).tolist(),
        "daily_totals_kwh": daily_totals,
        "total_daily_kwh": round(daily_totals[0], 2),  # Today's total
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
    uvicorn.run(app, host="127.0.0.1", port=8000)
