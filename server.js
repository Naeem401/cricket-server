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
const FETCH_INTERVAL = 30000; // 30 seconds for general updates
const LIVE_UPDATE_INTERVAL = 2000; // 2 seconds for live matches
const DETAILED_UPDATE_INTERVAL = 5000; // 5 seconds for detailed match data

// Data storage
const dataStore = {
  allMatches: [],
  liveMatches: new Map(), // eventKey -> basic match data
  detailedMatches: new Map(), // eventKey -> full match details
  lastUpdated: null
};

// Middleware
app.use(cors());
app.use(express.json());

// Socket.IO setup
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  
  // Initial data
  if (dataStore.allMatches.length > 0) {
    socket.emit('initial_data', {
      data: dataStore.allMatches,
      lastUpdated: dataStore.lastUpdated
    });
  }

  // Match list subscriptions
  socket.on('subscribe_list', () => {
    socket.join('match_list');
    console.log(`Client subscribed to match list updates`);
  });

  // Detailed match subscriptions
  socket.on('subscribe_match', (eventKey) => {
    socket.join(`match_${eventKey}`);
    console.log(`Client subscribed to match ${eventKey}`);
    
    // Send current data if available
    if (dataStore.detailedMatches.has(eventKey)) {
      socket.emit(`match_${eventKey}_details`, dataStore.detailedMatches.get(eventKey));
    }
  });

  socket.on('unsubscribe_match', (eventKey) => {
    socket.leave(`match_${eventKey}`);
    console.log(`Client unsubscribed from match ${eventKey}`);
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// Main match data fetcher
const fetchAllMatches = async () => {
  try {
    const today = moment();
    const date_start = today.clone().subtract(14, 'days').format('YYYY-MM-DD');
    const date_stop = today.clone().add(14, 'days').format('YYYY-MM-DD');

    const url = `${BASE_URL}?method=get_events&APIkey=${API_KEY}&date_start=${date_start}&date_stop=${date_stop}`;
    const response = await axios.get(url);

    dataStore.allMatches = response.data?.result || [];
    dataStore.lastUpdated = new Date();

    console.log(`Fetched ${dataStore.allMatches.length} matches`);
    
    // Process live matches
    updateLiveMatches(dataStore.allMatches);

    // Broadcast to match list subscribers
    io.to('match_list').emit('matches_update', {
      data: dataStore.allMatches,
      lastUpdated: dataStore.lastUpdated
    });

  } catch (error) {
    console.error('Error fetching matches:', error.message);
  }
};

// Process live matches
const updateLiveMatches = (matches) => {
  const liveMatches = matches.filter(match => 
    match.event_status === 'In Progress' || match.event_live === '1'
  );

  // Update existing live matches
  liveMatches.forEach(match => {
    const eventKey = match.event_key;
    const existing = dataStore.liveMatches.get(eventKey);
    
    if (!existing || JSON.stringify(existing) !== JSON.stringify(match)) {
      dataStore.liveMatches.set(eventKey, match);
      io.to('match_list').emit('match_updated', match);
    }
  });

  // Remove finished matches
  const currentLiveKeys = new Set(liveMatches.map(m => m.event_key));
  dataStore.liveMatches.forEach((_, key) => {
    if (!currentLiveKeys.has(key)) {
      dataStore.liveMatches.delete(key);
    }
  });
};

// Fetch detailed match data
const fetchDetailedMatchData = async (eventKey) => {
  try {
    const url = `${BASE_URL}?method=get_event&APIkey=${API_KEY}&event_key=${eventKey}`;
    const response = await axios.get(url);
    const detailedData = response.data?.result || {};
    
    // Store and broadcast
    dataStore.detailedMatches.set(eventKey, detailedData);
    io.to(`match_${eventKey}`).emit(`match_${eventKey}_details`, detailedData);
    
    return detailedData;
  } catch (error) {
    console.error(`Error fetching details for match ${eventKey}:`, error.message);
    return null;
  }
};

// Background jobs
setInterval(fetchAllMatches, FETCH_INTERVAL);
setInterval(() => {
  // Update detailed data for live matches
  dataStore.liveMatches.forEach((_, key) => {
    fetchDetailedMatchData(key);
  });
}, DETAILED_UPDATE_INTERVAL);

// Routes
app.get('/', (req, res) => {
  res.json({
    status: 'Cricket API Server',
    endpoints: {
      matches: '/matches',
      match_details: '/matches/:eventKey',
      h2h: '/h2h?event_key=',
      standings: '/standings'
    },
    last_updated: dataStore.lastUpdated
  });
});

// Get all matches
app.get('/matches', (req, res) => {
  res.json({
    data: dataStore.allMatches,
    lastUpdated: dataStore.lastUpdated
  });
});

// Get detailed match data
app.get('/matches/:eventKey', async (req, res) => {
  try {
    let matchData = dataStore.detailedMatches.get(req.params.eventKey);
    
    if (!matchData) {
      // If not in cache, fetch fresh data
      matchData = await fetchDetailedMatchData(req.params.eventKey);
    }
    
    if (!matchData) {
      return res.status(404).json({ error: 'Match not found' });
    }
    
    res.json(matchData);
  } catch (error) {
    console.error('Error getting match details:', error);
    res.status(500).json({ error: 'Failed to get match details' });
  }
});

// Head-to-head route (unchanged from your original)
// Head-to-head route - simplified version
app.get('/h2h', async (req, res) => {
  const { first_team_key, second_team_key } = req.query;
  
  if (!first_team_key || !second_team_key) {
    return res.status(400).json({ 
      success: 0,
      error: 'Both first_team_key and second_team_key are required',
      example: '/h2h?first_team_key=147&second_team_key=149' 
    });
  }

  try {
    const h2hRes = await axios.get(
      `${BASE_URL}?method=get_H2H&APIkey=${API_KEY}` +
      `&first_team_key=${first_team_key}` +
      `&second_team_key=${second_team_key}`
    );

    res.json({
      success: 1,
      data: h2hRes.data
    });
  } catch (error) {
    console.error('H2H Error:', error.response?.data || error.message);
    res.status(500).json({
      success: 0,
      error: 'Failed to fetch H2H data',
      api_error: error.response?.data || error.message
    });
  }
});

// Standings route (unchanged from your original)
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

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err.stack);
  res.status(500).json({ error: 'Something went wrong on the server!' });
});

// Initial data load
fetchAllMatches().then(() => {
  console.log('Initial data loaded');
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket ready for real-time updates`);
});