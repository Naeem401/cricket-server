const express = require('express');
const axios = require('axios');
const moment = require('moment');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = 3000;
const API_KEY = 'eaeb6c6d25b8352b28320e08174ea3b48f4d5e6e7f912bdb72445f733fd83e2b';
const BASE_URL = 'https://apiv2.api-cricket.com/cricket/';
const FETCH_INTERVAL = 30000; // 30 seconds

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage for events data
let cachedEvents = [];
let lastUpdated = null;

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('New client connected');
  
  // Send initial events data
  if (cachedEvents.length > 0) {
    socket.emit('events', {
      data: cachedEvents,
      lastUpdated: lastUpdated
    });
  }
  
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Background job to fetch and update events data
const fetchEvents = async () => {
  try {
    const today = moment();
    const date_start = today.clone().subtract(14, 'days').format('YYYY-MM-DD');
    const date_stop = today.clone().add(14, 'days').format('YYYY-MM-DD');

    const url = `${BASE_URL}?method=get_events&APIkey=${API_KEY}&date_start=${date_start}&date_stop=${date_stop}`;
    console.log('Fetching from URL:', url);

    const response = await axios.get(url);

    // Fix here
    cachedEvents = response.data?.result || [];
    lastUpdated = new Date();

    console.log('Events fetched:', cachedEvents.length);
    console.log('Last updated:', lastUpdated.toISOString());

    // Broadcast to all connected clients
    io.emit('events', {
      data: cachedEvents,
      lastUpdated: lastUpdated
    });
  } catch (error) {
    console.error('Error fetching events:', error.message);
  }
};


// Start periodic updates
setInterval(fetchEvents, FETCH_INTERVAL);
fetchEvents(); // Initial fetch

// Routes (keeping your existing routes)
app.get('/', (req, res) => {
  res.send('Welcome to the Cricket API with real-time events updates!');
});

// Get Events (returns cached data)
app.get('/events', (req, res) => {
  if (cachedEvents.length === 0) {
    return res.status(503).json({ error: 'Events data not loaded yet' });
  }
  res.json({
    data: cachedEvents,
    lastUpdated: lastUpdated
  });
});

// Get Head-to-Head (your existing route)
app.get('/h2h', async (req, res) => {
  const { event_key } = req.query;
  
  if (!event_key) {
    return res.status(400).json({ error: 'event_key is required' });
  }

  try {
    const eventRes = await axios.get(
      `${BASE_URL}?method=get_events&APIkey=${API_KEY}`
    );

    const event = eventRes.data?.result?.find(ev => ev.event_key == event_key);

    if (!event) {
      return res.status(404).json({ error: 'Event not found for given event_key' });
    }

    const first_team_key = event.home_team_key;
    const second_team_key = event.away_team_key;

    const h2hRes = await axios.get(
      `${BASE_URL}?method=get_H2H&APIkey=${API_KEY}&first_team_key=${first_team_key}&second_team_key=${second_team_key}`
    );

    const responseData = {
      event_info: {
        event_name: `${event.event_home_team} vs ${event.event_away_team}`,
        date: event.event_date_start,
        league: event.league_name,
      },
      h2h_data: h2hRes.data
    };

    res.json(responseData);
  } catch (error) {
    console.error(error.message);
    res.status(500).json({ error: 'Failed to fetch H2H data via event.' });
  }
});

// Get Standings (your existing route)
app.get('/standings', async (req, res) => {
  const { event_key, league_key } = req.query;

  let dynamic_league_key = league_key;

  if (event_key) {
    try {
      const eventRes = await axios.get(
        `${BASE_URL}?method=get_events&APIkey=${API_KEY}`
      );

      const event = eventRes.data?.result?.find(ev => ev.event_key == event_key);

      if (!event) {
        return res.status(404).json({ error: 'Event not found for given event_key' });
      }

      dynamic_league_key = event.league_key;
    } catch (error) {
      console.error('Failed to fetch event data:', error.message);
      return res.status(500).json({ error: 'Failed to fetch event data.' });
    }
  } else if (!league_key) {
    return res.status(400).json({ error: 'league_key or event_key is required' });
  }

  try {
    const response = await axios.get(
      `${BASE_URL}?method=get_standings&league_key=${dynamic_league_key}&APIkey=${API_KEY}`
    );
    
    res.json(response.data);
  } catch (error) {
    console.error('Failed to fetch standings:', error.message);
    res.status(500).json({ error: 'Failed to fetch standings.' });
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket server ready for real-time events updates`);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err.stack);
  res.status(500).json({ error: 'Something went wrong on the server!' });
});