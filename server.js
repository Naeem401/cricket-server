require('dotenv').config();
const express = require('express');
const axios = require('axios');
const moment = require('moment');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// API Configuration
const API_KEY = process.env.API_KEY || '988f3dc89151ef1679f5e3f28a3104b00b93f765a3e271149ed6de90a53e909e';
const API_BASE_URL = 'https://apiv2.api-cricket.com/cricket/';

// Helper function to format dates
function getDateRange() {
    const today = moment();
    const startDate = today.clone().subtract(14, 'days').format('YYYY-MM-DD');
    const endDate = today.clone().add(15, 'days').format('YYYY-MM-DD');
    return { startDate, endDate };
}

// Route to get cricket events for dynamic 30-day period
app.get('/api/cricket/events', async (req, res) => {
    try {
        const { startDate, endDate } = getDateRange();
        const { league_key, event_key } = req.query;
        
        let url = `${API_BASE_URL}?method=get_events&APIkey=${API_KEY}&date_start=${startDate}&date_stop=${endDate}`;
        
        if (league_key) {
            url += `&league_key=${league_key}`;
        }
        
        if (event_key) {
            url += `&event_key=${event_key}`;
        }
        
        const response = await axios.get(url);
        res.json({
            success: true,
            dateRange: { startDate, endDate },
            data: response.data
        });
    } catch (error) {
        console.error('Error fetching cricket events:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch cricket events',
            error: error.message
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Example endpoint: http://localhost:${PORT}/api/cricket/events`);
});