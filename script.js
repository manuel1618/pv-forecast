document.addEventListener('DOMContentLoaded', function () {
    const form = document.getElementById('forecast-form');
    const resultsContainer = document.getElementById('results-container');
    const totalKwhElement = document.getElementById('total-kwh');
    const chartCanvas = document.getElementById('forecast-chart');
    const loadingSpinner = document.getElementById('loading-spinner');
    const errorMessage = document.getElementById('error-message');
    const addressInput = document.getElementById('address');
    const suggestionsContainer = document.getElementById('address-suggestions');

    // Constants
    const DEBOUNCE_DELAY = 300;
    const MIN_QUERY_LENGTH = 3;
    const CACHE_TTL = 3600000; // 1 hour in milliseconds
    
    // State variables
    let chart;
    let debounceTimer;
    let selectedSuggestionIndex = -1;
    let currentDayOffset = 0; // 0 = today, 1 = tomorrow, -1 = yesterday
    let forecastData = null; // Store the forecast data for navigation
    let temperatureData = null; // Store temperature data for overlay
    let isDarkMode = false;

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
    function calculateSimplePvEnergy(irradiance, ambientTemp, system) {
        /**
         * PV energy calculation with temperature efficiency:
         * Power = System Power * (Irradiance / 1000) * Temperature Factor * Base Efficiency
         * 
         * The weather API handles angles, but temperature affects panel performance.
         * East-facing panels are cooler in the morning, south-facing hottest at noon.
         */
        
        // Get temperature settings from user input
        const temperatureCoefficient = parseFloat(document.getElementById('temperature-coefficient').value);
        const STC_TEMPERATURE = parseFloat(document.getElementById('stc-temperature').value);
        const baseEfficiency = 0.75; // Base system efficiency
        
        const hourlyEnergy = irradiance.map((irr, i) => {
            // Convert irradiance to power ratio (1000 W/m² = 100%)
            const powerRatio = irr / 1000;
            
            // Estimate cell temperature (simplified model)
            const cellTemperature = ambientTemp[i] + (irr / 1000) * 20;
            
            // Calculate temperature derating factor
            const temperatureFactor = 1 + temperatureCoefficient * (cellTemperature - STC_TEMPERATURE);
            
            // Calculate hourly energy with temperature correction
            return system.power * powerRatio * baseEfficiency * temperatureFactor;
        });

        return hourlyEnergy;
    }
    

    // --- Event Listeners ---
    form.addEventListener('submit', handleFormSubmit);
    
    // Chart navigation
    document.getElementById('prev-day-btn').addEventListener('click', () => navigateDay(-1));
    document.getElementById('next-day-btn').addEventListener('click', () => navigateDay(1));
    
    // Chart view toggles
    document.getElementById('daily-view').addEventListener('change', updateChartView);
    document.getElementById('weekly-view').addEventListener('change', updateChartView);
    document.getElementById('show-temperature').addEventListener('change', updateChartView);
    
    // Export and share
    document.getElementById('export-btn').addEventListener('click', exportToCSV);
    document.getElementById('share-btn').addEventListener('click', shareResults);
    
    // Dark mode
    document.getElementById('dark-mode-toggle').addEventListener('click', toggleDarkMode);
    
    // Advanced settings - save when changed
    document.getElementById('temperature-coefficient').addEventListener('change', saveFormData);
    document.getElementById('stc-temperature').addEventListener('change', saveFormData);
    
    // Clear data
    document.getElementById('clear-data-btn').addEventListener('click', function() {
        if (confirm('Are you sure you want to clear all saved data? This will reset the form and clear the cache.')) {
            clearSavedData();
            // Reset form
            document.getElementById('forecast-form').reset();
            // Reset address field to normal state
            resetGPSCoordinates();
            // Reset all 3 systems to default values
            const systems = document.querySelectorAll('.pv-system-group');
            systems.forEach(system => {
                system.querySelector('input[name="power"]').value = '0';
                system.querySelector('input[name="inclination"]').value = '10';
                system.querySelector('input[name="azimuth"]').value = '0';
            });
            // Reset advanced settings to default
            const tempCoeffElement = document.getElementById('temperature-coefficient');
            const stcTempElement = document.getElementById('stc-temperature');
            if (tempCoeffElement) {
                tempCoeffElement.value = '-0.003';
            }
            if (stcTempElement) {
                stcTempElement.value = '25';
            }
            // Clear results
            if (forecastData) {
                document.getElementById('results-container').style.display = 'none';
                forecastData = null;
                temperatureData = null;
            }
            // Reset dark mode
            if (isDarkMode) {
                toggleDarkMode();
            }
        }
    });
    
    // Address autocomplete
    
    if (addressInput) {
        addressInput.addEventListener('input', handleAddressInput);
        addressInput.addEventListener('keydown', handleAddressKeydown);
        addressInput.addEventListener('blur', hideSuggestions);
        addressInput.addEventListener('focus', function() {
            if (suggestionsContainer.children.length > 0) {
                showSuggestions();
            }
        });
    }

    // No dynamic system functions needed - we have 3 static systems

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

            if (power && inclination && azimuth) {
                pvSystems.push({
                    power: parseFloat(power),
                    inclination: parseFloat(inclination),
                    azimuth: parseFloat(azimuth)
                });
            }
        });

        if (pvSystems.length === 0) {
            showError('Please fill out at least one PV system.');
            loadingSpinner.style.display = 'none';
            return;
        }

        try {
            let latitude, longitude;
            
            // Check if we're using saved GPS coordinates
            if (address === 'Relying on GPS coordinates') {
                // Get coordinates from localStorage
                const savedData = localStorage.getItem('pvForecastFormData');
                if (savedData) {
                    const formData = JSON.parse(savedData);
                    if (formData.latitude && formData.longitude) {
                        latitude = formData.latitude;
                        longitude = formData.longitude;
                    } else {
                        throw new Error('No saved GPS coordinates found');
                    }
                } else {
                    throw new Error('No saved GPS coordinates found');
                }
            } else {
                // Step 1: Geocode the address
                const location = await geocodeAddress(address);
                if (!location) {
                    throw new Error(`Address not found: '${address}'. Please try a more specific address.`);
                }
                latitude = location.latitude;
                longitude = location.longitude;
                
                // Save GPS coordinates and address when user calculates
                saveGPSCoordinates(latitude, longitude, address);
            }

            // Step 2: Get weather data and calculate PV energy for each system
            let totalHourlyKwh = new Array(168).fill(0); // 7 days * 24 hours

            for (const system of pvSystems) {
                try {
                    // Get weather data from Open-Meteo API
                    const weatherData = await getWeatherData(latitude, longitude, system.inclination, system.azimuth);
                    
                    // Extract irradiance and temperature data
                    const irradiance = weatherData.hourly.global_tilted_irradiance;
                    const ambientTemp = weatherData.hourly.temperature_2m;

                    // Store temperature data for the first system (they should be similar)
                    if (!temperatureData) {
                        temperatureData = ambientTemp;
                    }

                    // Calculate PV energy using our transparent JavaScript function
                    const hourlyKwh = calculateSimplePvEnergy(irradiance, ambientTemp, system);

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
        
        // Save PV systems data when calculation is complete
        saveFormData();
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
        const dayTempData = temperatureData ? temperatureData.slice(startHour, endHour) : null;
        const showTemp = document.getElementById('show-temperature').checked;
        renderChart(dayData, dayTempData, showTemp);
        
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

    function renderChart(hourlyData, tempData = null, showTemp = false) {
        const ctx = chartCanvas.getContext('2d');
        const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);

        if (chart) {
            chart.destroy();
        }

        const datasets = [{
            label: 'Expected Energy (kWh)',
            data: hourlyData,
            backgroundColor: 'rgba(54, 162, 235, 0.8)',
            borderColor: 'rgba(54, 162, 235, 1)',
            borderWidth: 1,
            yAxisID: 'y',
            barThickness: 'flex',
            maxBarThickness: 50
        }];

        if (showTemp && tempData) {
            datasets.push({
                label: 'Temperature (°C)',
                data: tempData,
                type: 'line',
                borderColor: 'rgba(255, 99, 132, 1)',
                backgroundColor: 'rgba(255, 99, 132, 0.2)',
                borderWidth: 2,
                fill: false,
                yAxisID: 'y1'
            });
        }

        chart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                devicePixelRatio: window.devicePixelRatio || 1,
                interaction: {
                    intersect: false,
                    mode: 'index'
                },
                scales: {
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Energy (kWh)'
                        },
                        ticks: {
                            maxTicksLimit: window.innerWidth < 576 ? 5 : 8
                        }
                    },
                    y1: {
                        type: 'linear',
                        display: showTemp,
                        position: 'right',
                        title: {
                            display: true,
                            text: 'Temperature (°C)',
                            rotation: 270
                        },
                        grid: {
                            drawOnChartArea: false,
                        },
                    },
                    x: {
                        title: {
                            display: true,
                            text: 'Hour of the Day'
                        },
                        ticks: {
                            maxTicksLimit: window.innerWidth < 576 ? 12 : 24,
                            maxRotation: window.innerWidth < 576 ? 45 : 0
                        }
                    }
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                if (context.datasetIndex === 0) {
                                    return `Energy: ${context.raw.toFixed(2)} kWh`;
                                } else {
                                    return `Temperature: ${context.raw.toFixed(1)}°C`;
                                }
                            }
                        }
                    },
                    legend: {
                        display: showTemp
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
        const latitude = parseFloat(suggestionElement.dataset.latitude);
        const longitude = parseFloat(suggestionElement.dataset.longitude);
        
        addressInput.value = address;
        hideSuggestions();
        selectedSuggestionIndex = -1;
        
        // GPS coordinates will be saved when user calculates forecast
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
    
    // Initialize tooltips after a short delay to ensure DOM is ready
    setTimeout(() => {
        const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
        tooltipTriggerList.map(function (tooltipTriggerEl) {
            return new bootstrap.Tooltip(tooltipTriggerEl);
        });
    }, 100);
    
    // Initialize dark mode from localStorage
    const savedDarkMode = localStorage.getItem('darkMode') === 'true';
    if (savedDarkMode) {
        toggleDarkMode();
    }
    
    // Load saved form data
    loadSavedFormData();

    // --- New Feature Functions ---
    function updateChartView() {
    if (!forecastData) return;
    
    const isWeekly = document.getElementById('weekly-view').checked;
    const showTemp = document.getElementById('show-temperature').checked;
    
    if (isWeekly) {
        renderWeeklyChart(showTemp);
    } else {
        const dayIndex = currentDayOffset;
        const startHour = dayIndex * 24;
        const endHour = startHour + 24;
        const dayData = forecastData.hourly_forecast_kwh.slice(startHour, endHour);
        const dayTempData = temperatureData ? temperatureData.slice(startHour, endHour) : null;
        renderChart(dayData, dayTempData, showTemp);
    }
}

    function renderWeeklyChart(showTemp = false) {
    const ctx = chartCanvas.getContext('2d');
    const labels = [];
    const energyData = [];
    const tempData = [];
    
    // Create labels for each day
    for (let day = 0; day < 7; day++) {
        const date = new Date();
        date.setDate(date.getDate() + day);
        labels.push(date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));
        
        // Calculate daily total
        const startHour = day * 24;
        const endHour = startHour + 24;
        const dailyEnergy = forecastData.hourly_forecast_kwh.slice(startHour, endHour).reduce((sum, val) => sum + val, 0);
        energyData.push(Math.round(dailyEnergy * 100) / 100);
        
        // Calculate average temperature
        if (temperatureData && showTemp) {
            const dailyTemp = temperatureData.slice(startHour, endHour);
            const avgTemp = dailyTemp.reduce((sum, val) => sum + val, 0) / dailyTemp.length;
            tempData.push(Math.round(avgTemp * 10) / 10);
        }
    }

    if (chart) {
        chart.destroy();
    }

    const datasets = [{
        label: 'Daily Energy (kWh)',
        data: energyData,
        backgroundColor: 'rgba(54, 162, 235, 0.8)',
        borderColor: 'rgba(54, 162, 235, 1)',
        borderWidth: 1,
        yAxisID: 'y',
        barThickness: 'flex',
        maxBarThickness: 80
    }];

    if (showTemp && tempData.length > 0) {
        datasets.push({
            label: 'Avg Temperature (°C)',
            data: tempData,
            type: 'line',
            borderColor: 'rgba(255, 99, 132, 1)',
            backgroundColor: 'rgba(255, 99, 132, 0.2)',
            borderWidth: 2,
            fill: false,
            yAxisID: 'y1'
        });
    }

    chart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            devicePixelRatio: window.devicePixelRatio || 1,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            scales: {
                y: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    title: {
                        display: true,
                        text: 'Energy (kWh)'
                    }
                },
                y1: {
                    type: 'linear',
                    display: showTemp,
                    position: 'right',
                    title: {
                        display: true,
                        text: 'Temperature (°C)',
                        rotation: 270       
                    },
                    grid: {
                        drawOnChartArea: false,
                    },
                }
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            if (context.datasetIndex === 0) {
                                return `Energy: ${context.raw.toFixed(2)} kWh`;
                            } else {
                                return `Temperature: ${context.raw.toFixed(1)}°C`;
                            }
                        }
                    }
                }
            }
        }
    });
}

    function exportToCSV() {
    if (!forecastData) return;
    
    let csv = 'Date,Time,Energy (kWh),Temperature (°C)\n';
    
    for (let hour = 0; hour < 168; hour++) {
        const date = new Date();
        date.setDate(date.getDate() + Math.floor(hour / 24));
        const hourOfDay = hour % 24;
        
        const dateStr = date.toISOString().split('T')[0];
        const timeStr = `${hourOfDay.toString().padStart(2, '0')}:00`;
        const energy = forecastData.hourly_forecast_kwh[hour] || 0;
        const temp = temperatureData ? (temperatureData[hour] || 0) : '';
        
        csv += `${dateStr},${timeStr},${energy.toFixed(2)},${temp}\n`;
    }
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pv-forecast-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
}

    function shareResults() {
    if (!forecastData) return;
    
    const totalEnergy = forecastData.daily_totals_kwh.reduce((sum, val) => sum + val, 0);
    const avgDaily = (totalEnergy / 7).toFixed(1);
    
    const shareText = `🌞 PV Forecast Results:\n` +
        `📍 Location: ${document.getElementById('address').value}\n` +
        `⚡ Total 7-day energy: ${totalEnergy.toFixed(1)} kWh\n` +
        `📊 Average daily: ${avgDaily} kWh\n` +
        `🔗 Generated with PV Forecast Calculator`;
    
    if (navigator.share) {
        navigator.share({
            title: 'PV Forecast Results',
            text: shareText,
            url: window.location.href
        });
    } else {
        // Fallback: copy to clipboard
        navigator.clipboard.writeText(shareText).then(() => {
            alert('Results copied to clipboard!');
        });
    }
}

    function toggleDarkMode() {
    isDarkMode = !isDarkMode;
    const body = document.body;
    const icon = document.getElementById('dark-mode-icon');
    
    if (isDarkMode) {
        body.classList.add('dark-mode');
        icon.className = 'bi bi-sun';
    } else {
        body.classList.remove('dark-mode');
        icon.className = 'bi bi-moon';
    }
    
    // Save preference
    localStorage.setItem('darkMode', isDarkMode.toString());
    
    // Update chart colors if chart exists
    if (chart) {
        updateChartView();
    }
    }

    // --- Persistence Functions ---
    function saveGPSCoordinates(latitude, longitude, address = null) {
        try {
            const savedData = localStorage.getItem('pvForecastFormData');
            const formData = savedData ? JSON.parse(savedData) : { pvSystems: [] };
            
            formData.latitude = latitude;
            formData.longitude = longitude;
            if (address) {
                formData.address = address;
            }
            
            localStorage.setItem('pvForecastFormData', JSON.stringify(formData));
            
            // Show GPS coordinates display
            const gpsDisplay = document.getElementById('gps-coordinates-display');
            const gpsText = document.getElementById('gps-coordinates-text');
            
            if (address) {
                gpsText.innerHTML = `<strong>${address}</strong><br><small class="coordinates-text">${latitude.toFixed(6)}, ${longitude.toFixed(6)}</small>`;
            } else {
                gpsText.textContent = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
            }
            gpsDisplay.style.display = 'block';
        } catch (error) {
            console.warn('Failed to save GPS coordinates:', error);
        }
    }

    function saveFormData() {
        // Don't save during data loading
        if (window.isLoadingData) return;
        
        try {
            const savedData = localStorage.getItem('pvForecastFormData');
            const formData = savedData ? JSON.parse(savedData) : { pvSystems: [] };

            // Collect all PV system data
            document.querySelectorAll('.pv-system-group').forEach((group, index) => {
                const power = group.querySelector('input[name="power"]').value;
                const inclination = group.querySelector('input[name="inclination"]').value;
                const azimuth = group.querySelector('input[name="azimuth"]').value;

                if (power || inclination || azimuth) {
                    formData.pvSystems.push({
                        power: power || '',
                        inclination: inclination || '',
                        azimuth: azimuth || ''
                    });
                }
            });

            // Save advanced settings
            const tempCoeffElement = document.getElementById('temperature-coefficient');
            const stcTempElement = document.getElementById('stc-temperature');
            if (tempCoeffElement) {
                formData.temperatureCoefficient = tempCoeffElement.value;
            }
            if (stcTempElement) {
                formData.stcTemperature = stcTempElement.value;
            }

            // Save to localStorage
            localStorage.setItem('pvForecastFormData', JSON.stringify(formData));
            
            // Data saved silently
        } catch (error) {
            console.warn('Failed to save form data:', error);
        }
    }

    function loadSavedFormData() {
        try {
            const savedData = localStorage.getItem('pvForecastFormData');
            if (!savedData) return;

            const formData = JSON.parse(savedData);
            
            // Set flag to prevent auto-save during loading
            window.isLoadingData = true;
            
            // Restore GPS coordinates if available
            if (formData.latitude && formData.longitude) {
                const addressInput = document.getElementById('address');
                addressInput.value = 'Relying on GPS coordinates';
                addressInput.readOnly = true;
                addressInput.classList.add('address-gps-mode');
                addressInput.title = 'Click to reset and enter a new address';
                
                // Show GPS coordinates display
                const gpsDisplay = document.getElementById('gps-coordinates-display');
                const gpsText = document.getElementById('gps-coordinates-text');
                
                if (formData.address) {
                    gpsText.innerHTML = `<strong>${formData.address}</strong><br><small class="coordinates-text">${formData.latitude.toFixed(6)}, ${formData.longitude.toFixed(6)}</small>`;
                } else {
                    gpsText.textContent = `${formData.latitude.toFixed(6)}, ${formData.longitude.toFixed(6)}`;
                }
                gpsDisplay.style.display = 'block';
                
                // Add click handler to reset GPS coordinates (remove existing ones first)
                addressInput.removeEventListener('click', resetGPSCoordinates);
                addressInput.addEventListener('click', resetGPSCoordinates);
            }

            // Restore PV systems (always 3 systems)
            if (formData.pvSystems && formData.pvSystems.length > 0) {
                const systems = document.querySelectorAll('.pv-system-group');
                for (let i = 0; i < Math.min(3, formData.pvSystems.length); i++) {
                    const system = systems[i];
                    const data = formData.pvSystems[i];
                    if (system && data) {
                        system.querySelector('input[name="power"]').value = data.power || '0';
                        system.querySelector('input[name="inclination"]').value = data.inclination || '10';
                        system.querySelector('input[name="azimuth"]').value = data.azimuth || '0';
                    }
                }
            }

            // Restore advanced settings
            if (formData.temperatureCoefficient) {
                const tempCoeffElement = document.getElementById('temperature-coefficient');
                if (tempCoeffElement) {
                    tempCoeffElement.value = formData.temperatureCoefficient;
                }
            }
            if (formData.stcTemperature) {
                const stcTempElement = document.getElementById('stc-temperature');
                if (stcTempElement) {
                    stcTempElement.value = formData.stcTemperature;
                }
            }
            
            // Clear the loading flag
            window.isLoadingData = false;

        } catch (error) {
            console.warn('Failed to load form data:', error);
            window.isLoadingData = false;
        }
    }

    function clearSavedData() {
        try {
            localStorage.removeItem('pvForecastFormData');
            localStorage.removeItem('darkMode');
            // Clear all cache entries
            Object.keys(localStorage).forEach(key => {
                if (key.startsWith('geocode_') || key.startsWith('weather_')) {
                    localStorage.removeItem(key);
                }
            });
        } catch (error) {
            console.warn('Failed to clear saved data:', error);
        }
    }

    function resetGPSCoordinates() {
        // Reset address field to normal state
        const addressInput = document.getElementById('address');
        addressInput.value = '';
        addressInput.readOnly = false;
        addressInput.classList.remove('address-gps-mode');
        addressInput.title = '';
        
        // Hide GPS coordinates display
        const gpsDisplay = document.getElementById('gps-coordinates-display');
        gpsDisplay.style.display = 'none';
        
        // Remove click handler
        addressInput.removeEventListener('click', resetGPSCoordinates);
        
        // Clear GPS coordinates and address from localStorage
        try {
            const savedData = localStorage.getItem('pvForecastFormData');
            if (savedData) {
                const formData = JSON.parse(savedData);
                delete formData.latitude;
                delete formData.longitude;
                delete formData.address;
                localStorage.setItem('pvForecastFormData', JSON.stringify(formData));
            }
        } catch (error) {
            console.warn('Failed to clear GPS coordinates:', error);
        }
        
        // Focus on address input
        addressInput.focus();
    }

    // No auto-save - only save when user calculates forecast
});
