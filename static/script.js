
document.addEventListener('DOMContentLoaded', function () {
    const form = document.getElementById('forecast-form');
    const resultsContainer = document.getElementById('results-container');
    const totalKwhElement = document.getElementById('total-kwh');
    const chartCanvas = document.getElementById('forecast-chart');
    const loadingSpinner = document.getElementById('loading-spinner');
    const errorMessage = document.getElementById('error-message');
    const addSystemBtn = document.getElementById('add-system-btn');
    const systemsContainer = document.getElementById('pv-systems-container');
    const addressInput = document.getElementById('address');
    const suggestionsContainer = document.getElementById('address-suggestions');

    // Constants
    const DEBOUNCE_DELAY = 300;
    const MIN_QUERY_LENGTH = 3;
    const MAX_SUGGESTIONS = 5;
    const CACHE_TTL = 3600000; // 1 hour in milliseconds
    const STC_TEMPERATURE = 25.0; // Standard Test Conditions temperature in °C
    const STC_IRRADIANCE = 1000.0; // Standard Test Conditions irradiance in W/m²
    
    // State variables
    let chart;
    let systemCount = 1;
    let debounceTimer;
    let selectedSuggestionIndex = -1;
    let currentDayOffset = 0; // 0 = today, 1 = tomorrow, -1 = yesterday
    let forecastData = null; // Store the forecast data for navigation

    // --- Client-side caching ---
    const cache = {
        set: (key, data, ttl = CACHE_TTL) => {
            try {
                localStorage.setItem(key, JSON.stringify({
                    data,
                    expires: Date.now() + ttl
                }));
            } catch (e) {
                console.warn('Failed to cache data:', e);
            }
        },
        get: (key) => {
            try {
                const item = localStorage.getItem(key);
                if (!item) return null;
                const { data, expires } = JSON.parse(item);
                if (Date.now() > expires) {
                    localStorage.removeItem(key);
                    return null;
                }
                return data;
            } catch (e) {
                console.warn('Failed to retrieve cached data:', e);
                return null;
            }
        }
    };

    // --- PV Calculation Functions ---
    function calculateAdvancedPvEnergy(irradiance, ambientTemp, system) {
        /**
         * Advanced PV energy calculation following the 5-step model:
         * 1. Get POA irradiance (input)
         * 2. Estimate module cell temperature
         * 3. Correct module efficiency for temperature
         * 4. Calculate energy per time step
         * 5. Sum for daily total (handled by caller)
         */
        
        // Step 2: Estimate module cell temperature
        // T_c = T_a + ((NOCT - 20) / 800) * I_POA
        const cellTemperature = ambientTemp.map((temp, i) => 
            temp + ((system.noct - 20) / 800) * irradiance[i]
        );

        // Step 3: Correct module efficiency for temperature
        // η_mod,eff = η_STC * (1 + γ * (T_c - 25))
        const moduleEfficiency = cellTemperature.map(temp => 
            system.module_efficiency * (1 + system.temperature_coefficient * (temp - STC_TEMPERATURE))
        );

        // Step 4: Calculate energy per time step (1 hour)
        // E_step = (I_POA * A_mod * η_mod,eff * (1 - L) / 1000) * Δt
        // Where A_mod = P_rated / (η_STC * 1000) and Δt = 1 hour

        // Calculate module area from rated power and efficiency
        const moduleArea = (system.power * 1000) / (system.module_efficiency * STC_IRRADIANCE);

        // Calculate hourly energy in kWh
        const hourlyEnergy = irradiance.map((irr, i) => 
            (irr * moduleArea * moduleEfficiency[i] * (1 - system.system_losses) / 1000)
        );

        return hourlyEnergy;
    }

    // --- Event Listeners ---
    addSystemBtn.addEventListener('click', addSystemGroup);
    form.addEventListener('submit', handleFormSubmit);
    
    // Chart navigation
    document.getElementById('prev-day-btn').addEventListener('click', () => navigateDay(-1));
    document.getElementById('next-day-btn').addEventListener('click', () => navigateDay(1));
    
    // Address autocomplete
    addressInput.addEventListener('input', handleAddressInput);
    addressInput.addEventListener('keydown', handleAddressKeydown);
    addressInput.addEventListener('blur', hideSuggestions);
    addressInput.addEventListener('focus', function() {
        if (suggestionsContainer.children.length > 0) {
            showSuggestions();
        }
    });

    function addSystemGroup() {
        if (systemCount >= 3) {
            addSystemBtn.disabled = true;
            return;
        }
        systemCount++;

        const newSystem = document.querySelector('.pv-system-group').cloneNode(true);
        newSystem.querySelector('.badge').textContent = systemCount;
        
        // Clear all input values
        newSystem.querySelectorAll('input').forEach(input => {
            if (input.name === 'system_losses') input.value = '14';
            else if (input.name === 'module_efficiency') input.value = '18';
            else if (input.name === 'temperature_coefficient') input.value = '-0.0035';
            else if (input.name === 'noct') input.value = '45';
            else input.value = '';
        });
        
        // Update the advanced settings target ID
        const advancedBtn = newSystem.querySelector('[data-bs-target]');
        const advancedCollapse = newSystem.querySelector('.collapse');
        const newTargetId = `advanced-settings-${systemCount}`;
        advancedBtn.setAttribute('data-bs-target', `#${newTargetId}`);
        advancedCollapse.id = newTargetId;
        
        const removeBtn = newSystem.querySelector('.remove-system-btn');
        removeBtn.style.display = 'inline-block';
        removeBtn.addEventListener('click', () => {
            newSystem.remove();
            systemCount--;
            updateRemoveButtons();
            addSystemBtn.disabled = false;
        });

        systemsContainer.appendChild(newSystem);
        updateRemoveButtons();
    }

    function updateRemoveButtons() {
        const allRemoveButtons = systemsContainer.querySelectorAll('.remove-system-btn');
        allRemoveButtons.forEach(btn => btn.style.display = allRemoveButtons.length > 1 ? 'inline-block' : 'none');
    }

    async function handleFormSubmit(event) {
        event.preventDefault();
        
        // Reset UI
        loadingSpinner.style.display = 'block';
        resultsContainer.style.display = 'none';
        errorMessage.style.display = 'none';

        // Collect data
        const address = document.getElementById('address').value;
        const pvSystems = [];
        document.querySelectorAll('.pv-system-group').forEach(group => {
            const power = group.querySelector('input[name="power"]').value;
            const inclination = group.querySelector('input[name="inclination"]').value;
            const azimuth = group.querySelector('input[name="azimuth"]').value;
            const systemLosses = group.querySelector('input[name="system_losses"]').value || 14;
            const moduleEfficiency = group.querySelector('input[name="module_efficiency"]').value || 18;
            const temperatureCoefficient = group.querySelector('input[name="temperature_coefficient"]').value || -0.0035;
            const noct = group.querySelector('input[name="noct"]').value || 45;

            if (power && inclination && azimuth) {
                pvSystems.push({
                    power: parseFloat(power),
                    inclination: parseFloat(inclination),
                    azimuth: parseFloat(azimuth),
                    system_losses: parseFloat(systemLosses) / 100, // Convert percentage to decimal
                    module_efficiency: parseFloat(moduleEfficiency) / 100, // Convert percentage to decimal
                    temperature_coefficient: parseFloat(temperatureCoefficient),
                    noct: parseFloat(noct)
                });
            }
        });

        if (pvSystems.length === 0) {
            showError('Please fill out at least one PV system.');
            loadingSpinner.style.display = 'none';
            return;
        }

        try {
            // Step 1: Geocode the address
            const location = await geocodeAddress(address);
            if (!location) {
                throw new Error(`Address not found: '${address}'. Please try a more specific address.`);
            }

            const latitude = location.latitude;
            const longitude = location.longitude;

            // Step 2: Get weather data and calculate PV energy for each system
            let totalHourlyKwh = new Array(168).fill(0); // 7 days * 24 hours

            for (const system of pvSystems) {
                try {
                    // Get weather data from Open-Meteo API
                    const weatherData = await getWeatherData(latitude, longitude, system.inclination, system.azimuth);
                    
                    // Extract irradiance and temperature data
                    const irradiance = weatherData.hourly.global_tilted_irradiance;
                    const ambientTemp = weatherData.hourly.temperature_2m;

                    // Calculate PV energy using our JavaScript function
                    const hourlyKwh = calculateAdvancedPvEnergy(irradiance, ambientTemp, system);

                    // Add to total (ensure we have 168 hours)
                    for (let i = 0; i < 168; i++) {
                        totalHourlyKwh[i] += (hourlyKwh[i] || 0);
                    }

                } catch (error) {
                    console.warn(`Failed to process PV system:`, system, error);
                    // Continue with other systems if one fails
                }
            }

            // Calculate daily totals
            const dailyTotals = [];
            for (let day = 0; day < 7; day++) {
                const startHour = day * 24;
                const endHour = startHour + 24;
                const dailyKwh = totalHourlyKwh.slice(startHour, endHour).reduce((sum, val) => sum + val, 0);
                dailyTotals.push(Math.round(dailyKwh * 100) / 100);
            }

            // Round hourly data
            const hourlyForecastKwh = totalHourlyKwh.map(val => Math.round(val * 100) / 100);

            const result = {
                latitude,
                longitude,
                hourly_forecast_kwh: hourlyForecastKwh,
                daily_totals_kwh: dailyTotals,
                total_daily_kwh: Math.round(dailyTotals[0] * 100) / 100
            };

            displayResults(result);

        } catch (error) {
            showError(error.message);
        } finally {
            loadingSpinner.style.display = 'none';
        }
    }

    function displayResults(data) {
        resultsContainer.style.display = 'block';
        forecastData = data; // Store the full forecast data
        currentDayOffset = 0; // Reset to today
        updateDisplay();
    }
    
    function updateDisplay() {
        if (!forecastData) return;
        
        const dayIndex = currentDayOffset;
        const dailyTotal = forecastData.daily_totals_kwh[dayIndex];
        totalKwhElement.textContent = dailyTotal.toFixed(2) + ' kWh';
        
        // Update date display
        const date = new Date();
        date.setDate(date.getDate() + currentDayOffset);
        const dateStr = date.toLocaleDateString('en-US', { 
            weekday: 'long', 
            month: 'short', 
            day: 'numeric' 
        });
        document.getElementById('current-date').textContent = dateStr;
        
        // Update chart with current day's data
        const startHour = dayIndex * 24;
        const endHour = startHour + 24;
        const dayData = forecastData.hourly_forecast_kwh.slice(startHour, endHour);
        renderChart(dayData);
        
        // Update navigation buttons
        updateNavigationButtons();
    }
    
    function updateNavigationButtons() {
        const prevBtn = document.getElementById('prev-day-btn');
        const nextBtn = document.getElementById('next-day-btn');
        
        prevBtn.disabled = currentDayOffset <= -6; // Allow 6 days back
        nextBtn.disabled = currentDayOffset >= 6;  // Allow 6 days forward
    }
    
    function navigateDay(direction) {
        const newOffset = currentDayOffset + direction;
        if (newOffset >= -6 && newOffset <= 6) {
            currentDayOffset = newOffset;
            updateDisplay();
        }
    }

    function renderChart(hourlyData) {
        const ctx = chartCanvas.getContext('2d');
        const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);

        if (chart) {
            chart.destroy();
        }

        chart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Expected Energy (kWh)',
                    data: hourlyData,
                    backgroundColor: 'rgba(54, 162, 235, 0.6)',
                    borderColor: 'rgba(54, 162, 235, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'kWh'
                        }
                    },
                    x: {
                        title: {
                            display: true,
                            text: 'Hour of the Day'
                        }
                    }
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return ` ${context.raw.toFixed(2)} kWh`;
                            }
                        }
                    },
                    legend: {
                        display: false
                    }
                }
            }
        });
    }

    function showError(message) {
        errorMessage.textContent = `Error: ${message}`;
        errorMessage.style.display = 'block';
    }

    // --- API Helper Functions ---
    async function geocodeAddress(address) {
        try {
            // Check cache first
            const cacheKey = `geocode_single_${address}`;
            const cached = cache.get(cacheKey);
            if (cached) {
                return cached;
            }

            const response = await fetch(
                `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1&addressdetails=1`,
                {
                    headers: {
                        'User-Agent': 'PV-Forecast-Calculator/1.0'
                    }
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            
            if (!data || data.length === 0) {
                return null;
            }

            const location = {
                latitude: parseFloat(data[0].lat),
                longitude: parseFloat(data[0].lon)
            };

            // Cache the result
            cache.set(cacheKey, location);
            
            return location;
        } catch (error) {
            console.error('Geocoding error:', error);
            throw new Error(`Geocoding failed: ${error.message}`);
        }
    }

    async function getWeatherData(latitude, longitude, tilt, azimuth) {
        try {
            // Check cache first
            const cacheKey = `weather_${latitude}_${longitude}_${tilt}_${azimuth}`;
            const cached = cache.get(cacheKey);
            if (cached) {
                return cached;
            }

            const url = new URL('https://api.open-meteo.com/v1/forecast');
            url.searchParams.set('latitude', latitude);
            url.searchParams.set('longitude', longitude);
            url.searchParams.set('hourly', 'global_tilted_irradiance,temperature_2m');
            url.searchParams.set('forecast_days', '7');
            url.searchParams.set('tilt', tilt);
            url.searchParams.set('azimuth', azimuth);

            const response = await fetch(url.toString());

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();

            // Cache the result
            cache.set(cacheKey, data);

            return data;
        } catch (error) {
            console.error('Weather API error:', error);
            throw new Error(`Weather data fetch failed: ${error.message}`);
        }
    }

    // --- Address Autocomplete Functions ---
    function handleAddressInput(event) {
        const query = event.target.value.trim();
        
        // Clear previous timer
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        
        // Hide suggestions if query is too short
        if (query.length < MIN_QUERY_LENGTH) {
            hideSuggestions();
            return;
        }
        
        // Debounce the API call
        debounceTimer = setTimeout(() => {
            fetchAddressSuggestions(query);
        }, DEBOUNCE_DELAY);
    }

    function handleAddressKeydown(event) {
        const suggestions = suggestionsContainer.children;
        
        if (suggestions.length === 0) return;
        
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                selectedSuggestionIndex = Math.min(selectedSuggestionIndex + 1, suggestions.length - 1);
                updateSuggestionSelection();
                break;
            case 'ArrowUp':
                event.preventDefault();
                selectedSuggestionIndex = Math.max(selectedSuggestionIndex - 1, -1);
                updateSuggestionSelection();
                break;
            case 'Enter':
                event.preventDefault();
                if (selectedSuggestionIndex >= 0) {
                    selectSuggestion(suggestions[selectedSuggestionIndex]);
                }
                break;
            case 'Escape':
                hideSuggestions();
                break;
        }
    }

    async function fetchAddressSuggestions(query) {
        try {
            // Check cache first
            const cacheKey = `geocode_${query}`;
            const cached = cache.get(cacheKey);
            if (cached) {
                displaySuggestions(cached);
                return;
            }

            // Call Nominatim API directly
            const response = await fetch(
                `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1`,
                {
                    headers: {
                        'User-Agent': 'PV-Forecast-Calculator/1.0'
                    }
                }
            );
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            
            // Transform Nominatim response to match our expected format
            const suggestions = data.map(item => ({
                address: item.display_name,
                latitude: parseFloat(item.lat),
                longitude: parseFloat(item.lon)
            }));
            
            // Cache the results
            cache.set(cacheKey, suggestions);
            
            if (suggestions.length > 0) {
                displaySuggestions(suggestions);
            } else {
                hideSuggestions();
            }
        } catch (error) {
            console.warn('Geocoding error:', error);
            hideSuggestions();
        }
    }

    function displaySuggestions(suggestions) {
        suggestionsContainer.innerHTML = '';
        selectedSuggestionIndex = -1;
        
        suggestions.forEach((suggestion, index) => {
            const suggestionElement = document.createElement('div');
            suggestionElement.className = 'dropdown-item suggestion-item';
            suggestionElement.textContent = suggestion.address;
            suggestionElement.dataset.address = suggestion.address;
            suggestionElement.dataset.latitude = suggestion.latitude;
            suggestionElement.dataset.longitude = suggestion.longitude;
            
            suggestionElement.addEventListener('click', () => selectSuggestion(suggestionElement));
            suggestionElement.addEventListener('mouseenter', () => {
                selectedSuggestionIndex = index;
                updateSuggestionSelection();
            });
            
            suggestionsContainer.appendChild(suggestionElement);
        });
        
        showSuggestions();
    }

    function updateSuggestionSelection() {
        const suggestions = suggestionsContainer.children;
        
        for (let i = 0; i < suggestions.length; i++) {
            if (i === selectedSuggestionIndex) {
                suggestions[i].classList.add('active');
            } else {
                suggestions[i].classList.remove('active');
            }
        }
    }

    function selectSuggestion(suggestionElement) {
        const address = suggestionElement.dataset.address;
        addressInput.value = address;
        hideSuggestions();
        selectedSuggestionIndex = -1;
    }

    function showSuggestions() {
        suggestionsContainer.style.display = 'block';
    }

    function hideSuggestions() {
        // Delay hiding to allow clicks on suggestions
        setTimeout(() => {
            suggestionsContainer.style.display = 'none';
            selectedSuggestionIndex = -1;
        }, 150);
    }
    
    // Initialize first remove button
    updateRemoveButtons();
});
