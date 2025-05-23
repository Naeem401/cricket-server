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
const SCORECARD_UPDATE_INTERVAL = 3000; // 3 seconds for scorecard updates

// Enhanced data storage with scorecard tracking
const dataStore = {
  allMatches: [],
  liveMatches: new Map(), // eventKey -> basic match data
  detailedMatches: new Map(), // eventKey -> full match details
  scorecardData: new Map(), // eventKey -> scorecard data
  lastUpdated: null
};

// Middleware
app.use(cors());
app.use(express.json());

// Socket.IO setup with enhanced error handling
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

  // Live matches subscription
  socket.on('subscribe_live', () => {
    socket.join('live_matches');
    console.log(`Client subscribed to live matches updates`);
    
    // Send current live matches if available
    const liveMatches = Array.from(dataStore.liveMatches.values());
    if (liveMatches.length > 0) {
      socket.emit('live_matches_update', {
        matches: liveMatches,
        lastUpdated: dataStore.lastUpdated
      });
    }
  });

  // Detailed match subscriptions
  socket.on('subscribe_match', (eventKey) => {
    try {
      socket.join(`match_${eventKey}`);
      console.log(`Client subscribed to match ${eventKey}`);
      
      // Send current data if available
      if (dataStore.detailedMatches.has(eventKey)) {
        socket.emit(`match_${eventKey}_details`, dataStore.detailedMatches.get(eventKey));
      }
      
      // Send scorecard data if available
      if (dataStore.scorecardData.has(eventKey)) {
        socket.emit(`match_${eventKey}_scorecard`, dataStore.scorecardData.get(eventKey));
      }
    } catch (error) {
      console.error(`Subscription error for match ${eventKey}:`, error);
    }
  });

  socket.on('unsubscribe_match', (eventKey) => {
    socket.leave(`match_${eventKey}`);
    console.log(`Client unsubscribed from match ${eventKey}`);
  });

  socket.on('unsubscribe_live', () => {
    socket.leave('live_matches');
    console.log(`Client unsubscribed from live matches`);
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// Enhanced match data fetcher with retry logic
const fetchAllMatches = async (retryCount = 0) => {
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
    if (retryCount < 3) {
      console.log(`Retrying... Attempt ${retryCount + 1}`);
      setTimeout(() => fetchAllMatches(retryCount + 1), 5000);
    }
  }
};

// Enhanced live match processor
const updateLiveMatches = (matches) => {
  const liveMatches = matches.filter(match => 
    (match.event_status?.toLowerCase() === 'in progress' || 
     match.event_status?.toLowerCase() === 'live') && 
    match.event_live === '1'
  );

  // Update existing live matches
  liveMatches.forEach(match => {
    const eventKey = match.event_key;
    const existing = dataStore.liveMatches.get(eventKey);
    
    if (!existing || JSON.stringify(existing) !== JSON.stringify(match)) {
      dataStore.liveMatches.set(eventKey, match);
      
      // Broadcast to both match list and live matches subscribers
      io.to('match_list').emit('match_updated', match);
      io.to('live_matches').emit('live_matches_update', {
        matches: Array.from(dataStore.liveMatches.values()),
        lastUpdated: new Date()
      });
      
      // If this is a new live match, immediately fetch detailed data
      if (!existing) {
        fetchDetailedMatchData(eventKey);
        fetchScorecardData(eventKey);
      }
    }
  });

  // Remove finished matches
  const currentLiveKeys = new Set(liveMatches.map(m => m.event_key));
  dataStore.liveMatches.forEach((_, key) => {
    if (!currentLiveKeys.has(key)) {
      dataStore.liveMatches.delete(key);
      dataStore.detailedMatches.delete(key);
      dataStore.scorecardData.delete(key);
      
      // Notify clients that match is no longer live
      io.to('live_matches').emit('live_matches_update', {
        matches: Array.from(dataStore.liveMatches.values()),
        lastUpdated: new Date()
      });
    }
  });
};

// Enhanced detailed match data fetcher
const fetchDetailedMatchData = async (eventKey, retryCount = 0) => {
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
    if (retryCount < 2) {
      setTimeout(() => fetchDetailedMatchData(eventKey, retryCount + 1), 3000);
    }
    return null;
  }
};

// Function to fetch scorecard data
const fetchScorecardData = async (eventKey, retryCount = 0) => {
  try {
    const url = `${BASE_URL}?method=get_event&APIkey=${API_KEY}&event_key=${eventKey}`;
    const response = await axios.get(url);
    const matchData = response.data?.result || {};
    
    // Extract scorecard data
    const scorecardData = {
      scorecard: matchData.scorecard || {},
      innings: matchData.innings || {},
      extra: matchData.extra || {},
      batsmen: matchData.batsmen || [],
      bowlers: matchData.bowlers || []
    };
    
    // Store and broadcast
    dataStore.scorecardData.set(eventKey, scorecardData);
    io.to(`match_${eventKey}`).emit(`match_${eventKey}_scorecard`, scorecardData);
    
    return scorecardData;
  } catch (error) {
    console.error(`Error fetching scorecard for match ${eventKey}:`, error.message);
    if (retryCount < 2) {
      setTimeout(() => fetchScorecardData(eventKey, retryCount + 1), 3000);
    }
    return null;
  }
};

// Background jobs with staggered timing
setInterval(fetchAllMatches, FETCH_INTERVAL);

setInterval(() => {
  // Update detailed data for live matches
  dataStore.liveMatches.forEach((_, key) => {
    fetchDetailedMatchData(key);
  });
}, DETAILED_UPDATE_INTERVAL);

setInterval(() => {
  // Update scorecard data for live matches
  dataStore.liveMatches.forEach((_, key) => {
    fetchScorecardData(key);
  });
}, SCORECARD_UPDATE_INTERVAL);

// API Routes
app.get('/', (req, res) => {
  res.json({
    status: 'Cricket API Server',
    endpoints: {
      matches: '/matches',
      live_matches: '/live',
      match_details: '/matches/:eventKey',
      match_scorecard: '/matches/:eventKey/scorecard',
      h2h: '/h2h?event_key=',
      standings: '/standings',
      highlights: '/highlights'
    },
    last_updated: dataStore.lastUpdated
  });
});

// Get all matches
app.get('/matches', (req, res) => {
  try {
    res.json({
      data: dataStore.allMatches,
      lastUpdated: dataStore.lastUpdated
    });
  } catch (error) {
    console.error('Error in /matches route:', error);
    res.status(500).json({ error: 'Failed to get matches' });
  }
});

// Get live matches
app.get('/live', (req, res) => {
  try {
    const liveMatches = Array.from(dataStore.liveMatches.values())
      .map(match => {
        const detailed = dataStore.detailedMatches.get(match.event_key) || {};
        const scorecard = dataStore.scorecardData.get(match.event_key) || {};
        return {
          ...match,
          detailed,
          scorecard
        };
      });
    
    res.json({
      count: liveMatches.length,
      matches: liveMatches,
      lastUpdated: dataStore.lastUpdated
    });
  } catch (error) {
    console.error('Error in /live route:', error);
    res.status(500).json({ error: 'Failed to get live matches' });
  }
});

// Enhanced highlights endpoint with 7-day default and optional filters
app.get('/highlights', async (req, res) => {
  try {
    // Set default parameters
    const limit = req.query.limit || 40;
    const offset = req.query.offset || 0;
    const timezone = req.query.timezone || 'Etc/UTC';
    
    // Prepare optional filters
    const optionalParams = {};
    if (req.query.countryName) optionalParams.countryName = req.query.countryName;
    if (req.query.leagueName) optionalParams.leagueName = req.query.leagueName;
    if (req.query.countryCode) optionalParams.countryCode = req.query.countryCode;
    if (req.query.leagueId) optionalParams.leagueId = req.query.leagueId;
    if (req.query.homeTeamName) optionalParams.homeTeamName = req.query.homeTeamName;
    if (req.query.awayTeamName) optionalParams.awayTeamName = req.query.awayTeamName;

    // Generate date ranges for last 7 days
    const dateRanges = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      dateRanges.push(date.toISOString().split('T')[0]);
    }

    // Try each date until we get results
    let highlights = [];
    for (const date of dateRanges) {
      try {
        const response = await axios.get('https://cricket-highlights-api.p.rapidapi.com/highlights', {
          params: {
            date,
            limit,
            offset,
            timezone,
            ...optionalParams
          },
          headers: {
            'x-rapidapi-host': 'cricket-highlights-api.p.rapidapi.com',
            'x-rapidapi-key': '23ed8f1637msh9d5ecb868166523p1db1adjsnab581199d3d5'
          },
          timeout: 5000
        });

        if (response.data?.data?.length > 0) {
          highlights = highlights.concat(response.data.data);
        }
      } catch (error) {
        console.error(`Error for date ${date}:`, error.message);
      }
    }

    // Handle empty results
    if (highlights.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No highlights available for the last 7 days',
        suggestions: [
          'Try different filters (country, league, team)',
          'Check if matches were played recently',
          'Verify your API key is active'
        ],
        planStatus: {
          tier: 'BASIC',
          remainingRequests: 'Check RapidAPI dashboard'
        }
      });
    }

    // Return successful response
    res.json({
      success: true,
      count: highlights.length,
      highlights,
      lastUpdated: new Date().toISOString(),
      parametersUsed: {
        dateRange: `${dateRanges[dateRanges.length - 1]} to ${dateRanges[0]}`,
        limit,
        offset,
        timezone,
        ...optionalParams
      }
    });

  } catch (error) {
    console.error('Highlights API Error:', {
      message: error.message,
      response: error.response?.data
    });
    
    res.status(500).json({
      error: 'Highlights service unavailable',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      support: 'contact@yourdomain.com'
    });
  }
});

// Enhance the live matches update interval
setInterval(() => {
  // Update live matches with more detailed data
  dataStore.liveMatches.forEach((match, key) => {
    fetchDetailedMatchData(key).then(detailedData => {
      if (detailedData) {
        // Merge detailed data with basic match data
        const updatedMatch = {
          ...match,
          ...detailedData
        };
        dataStore.liveMatches.set(key, updatedMatch);
        
        // Broadcast to live subscribers
        io.to('live_matches').emit('live_matches_update', {
          matches: Array.from(dataStore.liveMatches.values()),
          lastUpdated: new Date()
        });
      }
    });
  });
}, 3000); // Update every 3 seconds

// Get detailed match data
app.get('/matches/:eventKey', async (req, res) => {
  try {
    let matchData = dataStore.detailedMatches.get(req.params.eventKey);
    
    if (!matchData) {
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

// Get scorecard data
app.get('/matches/:eventKey/scorecard', async (req, res) => {
  try {
    let scorecardData = dataStore.scorecardData.get(req.params.eventKey);
    
    if (!scorecardData) {
      scorecardData = await fetchScorecardData(req.params.eventKey);
    }
    
    if (!scorecardData) {
      return res.status(404).json({ error: 'Scorecard not available' });
    }
    
    res.json(scorecardData);
  } catch (error) {
    console.error('Error getting scorecard:', error);
    res.status(500).json({ error: 'Failed to get scorecard' });
  }
});

// Head-to-head route
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

// Standings route
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

//************************************************************************* */
app.get('/matc', async (req, res) => {
  try {
    // Parameters
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    const timezone = req.query.timezone || 'Etc/UTC';
    
    // Optional filters
    const filters = {};
    const filterableFields = [
      'countryName', 'leagueName', 'countryCode', 
      'leagueId', 'homeTeamName', 'awayTeamName'
    ];
    
    filterableFields.forEach(field => {
      if (req.query[field]) filters[field] = req.query[field];
    });

    // Generate 7-day range (3 past + today + 3 future)
    const today = moment().utc().startOf('day');
    const dateRanges = [
      today.clone().subtract(3, 'days'),
      today.clone().subtract(2, 'days'),
      today.clone().subtract(1, 'days'),
      today.clone(),
      today.clone().add(1, 'days'),
      today.clone().add(2, 'days'),
      today.clone().add(3, 'days')
    ].map(date => date.format('YYYY-MM-DD'));

    console.log('Fetching matches for dates:', dateRanges);

    // 1. First get basic match data from your original API
    const basicMatchesResponse = await axios.get(`${BASE_URL}?method=get_events`, {
      params: {
        APIkey: API_KEY,
        date_start: dateRanges[0],
        date_stop: dateRanges[6],
        timezone: timezone,
        ...filters
      },
      timeout: 5000
    });

    const basicMatches = basicMatchesResponse.data?.result || [];
    
    // 2. Then enrich with RapidAPI data for each match
    const enrichedMatches = await Promise.all(
      basicMatches.map(async match => {
        try {
          // Get additional details from RapidAPI
          const rapidApiResponse = await axios.get('https://cricket-matches-api.p.rapidapi.com/matches', {
            params: {
              matchId: match.event_key, // Assuming event_key is the ID
              timezone: timezone
            },
            headers: {
              'x-rapidapi-host': 'cricket-matches-api.p.rapidapi.com',
              'x-rapidapi-key': '23ed8f1637msh9d5ecb868166523p1db1adjsnab581199d3d5'
            },
            timeout: 3000
          });

          return {
            ...match,
            rapidApiData: rapidApiResponse.data || null
          };
        } catch (rapidApiError) {
          console.error(`Failed to enrich match ${match.event_key}:`, rapidApiError.message);
          return {
            ...match,
            rapidApiData: null,
            rapidApiError: rapidApiError.message
          };
        }
      })
    );

    // Paginate results
    const paginatedMatches = enrichedMatches.slice(offset, offset + limit);

    // Response format
    res.json({
      success: true,
      count: paginatedMatches.length,
      matches: paginatedMatches,
      total: enrichedMatches.length,
      lastUpdated: new Date().toISOString(),
      parametersUsed: {
        dateRange: `${dateRanges[0]} to ${dateRanges[6]}`,
        days: 7,
        limit,
        offset,
        timezone,
        ...(Object.keys(filters).length > 0 && { filters })
      },
      dataSources: {
        primary: 'api-cricket.com',
        secondary: 'cricket-matches-api.rapidapi.com'
      }
    });

  } catch (error) {
    console.error('Error in /matc endpoint:', {
      message: error.message,
      stack: error.stack,
      response: error.response?.data
    });
    
    res.status(500).json({
      success: false,
      error: 'Failed to fetch match data',
      ...(process.env.NODE_ENV === 'development' && {
        debug: {
          message: error.message,
          stack: error.stack
        }
      })
    });
  }
});

//************************************************************************* */

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err.stack);
  res.status(500).json({ 
    error: 'Something went wrong on the server!',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Initial data load with retry
const initializeServer = async (attempt = 0) => {
  try {
    await fetchAllMatches();
    console.log('Initial data loaded successfully');
  } catch (error) {
    console.error('Initial data load failed:', error);
    if (attempt < 3) {
      console.log(`Retrying initial load... Attempt ${attempt + 1}`);
      setTimeout(() => initializeServer(attempt + 1), 5000);
    } else {
      console.error('Failed to load initial data after 3 attempts');
    }
  }
};

// Start server
initializeServer().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`WebSocket ready for real-time updates`);
  });
});