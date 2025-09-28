# PV Forecast Calculator - Static Version

A fully static HTML/JavaScript application for calculating photovoltaic (PV) energy forecasts. This version runs entirely in the browser without requiring a backend server.

## Features

- **Address Autocomplete**: Uses OpenStreetMap's Nominatim API for address suggestions
- **Weather Data**: Fetches real-time weather forecasts from Open-Meteo API
- **Advanced PV Calculations**: Implements the 5-step PV energy calculation model
- **Multiple PV Systems**: Support for up to 3 different PV system configurations
- **Interactive Charts**: Visual representation of hourly energy production
- **Client-Side Caching**: Reduces API calls with localStorage-based caching
- **Data Persistence**: Automatically saves form data and user preferences
- **Responsive Design**: Works on desktop and mobile devices

## How It Works

1. **Geocoding**: Converts addresses to coordinates using Nominatim API
2. **Weather Data**: Fetches irradiance and temperature data from Open-Meteo API
3. **PV Calculations**: Calculates energy production using advanced temperature and efficiency models
4. **Visualization**: Displays results in interactive charts with day-by-day navigation

## Files

- `index.html` - Main HTML file
- `script.js` - JavaScript application logic
- `style.css` - CSS styling

## Usage

1. Open `index.html` in a web browser
2. Enter an address (with autocomplete suggestions)
3. Configure your PV system(s):
   - Power (kWp)
   - Inclination angle (0-90°)
   - Azimuth angle (-180 to 180°)
   - System losses (%)
   - Advanced settings (module efficiency, temperature coefficient, NOCT)
4. Click "Calculate Forecast"
5. View results and navigate between days

## API Dependencies

### Nominatim (OpenStreetMap)
- **Purpose**: Address geocoding
- **URL**: `https://nominatim.openstreetmap.org/search`
- **Rate Limits**: 1 request per second (respected by caching)
- **CORS**: Supported

### Open-Meteo
- **Purpose**: Weather and irradiance data
- **URL**: `https://api.open-meteo.com/v1/forecast`
- **Rate Limits**: No strict limits for reasonable usage
- **CORS**: Supported

## Caching & Persistence

The application implements client-side caching and data persistence:

### **Caching**
- Reduce API calls
- Improve performance
- Respect rate limits
- Work offline for cached data
- Cache duration: 1 hour for all API responses

### **Data Persistence**
- **Auto-save**: Form data is automatically saved as you type
- **Dark mode preference**: Remembers your theme choice
- **Multiple PV systems**: Saves all configured systems
- **Address history**: Remembers your last entered address
- **Clear data option**: Trash button to reset all saved data

## PV Calculation Model

The application uses a 5-step PV energy calculation model:

1. **POA Irradiance**: Plane of Array irradiance from weather API
2. **Cell Temperature**: `T_c = T_a + ((NOCT - 20) / 800) * I_POA`
3. **Module Efficiency**: `η_mod,eff = η_STC * (1 + γ * (T_c - 25))`
4. **Hourly Energy**: `E_step = (I_POA * A_mod * η_mod,eff * (1 - L) / 1000) * Δt`
5. **Daily Totals**: Sum of hourly values

Where:
- `T_c` = Cell temperature
- `T_a` = Ambient temperature
- `NOCT` = Nominal Operating Cell Temperature
- `I_POA` = Plane of Array irradiance
- `η_STC` = Module efficiency at Standard Test Conditions
- `γ` = Temperature coefficient
- `A_mod` = Module area
- `L` = System losses
- `Δt` = Time step (1 hour)

## Deployment

This static application can be deployed to any web hosting service:

- **GitHub Pages**: Upload files to a repository and enable Pages
- **Netlify**: Drag and drop the files
- **Vercel**: Connect to a Git repository
- **Any web server**: Simply serve the files

## Browser Compatibility

- Modern browsers with ES6+ support
- Fetch API support
- LocalStorage support
- Canvas API support (for charts)

## Limitations

- Requires internet connection for API calls
- Subject to external API rate limits
- No server-side data persistence
- Limited to 7-day forecasts

## Comparison with Backend Version

| Feature | Backend Version | Static Version |
|---------|----------------|----------------|
| Server Required | ✅ Yes | ❌ No |
| Hosting Cost | 💰 Server costs | 🆓 Free hosting |
| API Rate Limits | 🛡️ Server-side caching | 🛡️ Client-side caching |
| Offline Support | ❌ No | ⚠️ Limited (cached data) |
| Scalability | 🔄 Server resources | 🔄 Browser resources |
| Maintenance | 🔧 Server maintenance | 🚀 Zero maintenance |

## Development

To modify the application:

1. Edit the respective files (`index.html`, `script.js`, `style.css`)
2. Test in a local browser
3. Deploy to your hosting service

No build process or dependencies required!
