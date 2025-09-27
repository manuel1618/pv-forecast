
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
    
    // State variables
    let chart;
    let systemCount = 1;
    let debounceTimer;
    let selectedSuggestionIndex = -1;
    let currentDayOffset = 0; // 0 = today, 1 = tomorrow, -1 = yesterday
    let forecastData = null; // Store the forecast data for navigation

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
            return;
        }

        const requestBody = {
            address: address,
            pv_systems: pvSystems
        };

        // Fetch from API
        try {
            const response = await fetch('/api/forecast', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.detail || 'An unknown error occurred.');
            }

            const data = await response.json();
            displayResults(data);

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
            const response = await fetch(`/api/geocode?query=${encodeURIComponent(query)}`);
            const data = await response.json();
            
            if (data.suggestions && data.suggestions.length > 0) {
                displaySuggestions(data.suggestions);
            } else {
                hideSuggestions();
            }
        } catch (error) {
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
