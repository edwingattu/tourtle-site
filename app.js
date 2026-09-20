window.state = { unlocked: 14, total: 78, tileProgress: 68, today: 32, streak: 4, activities: 2, tracking: false, category: 'Dining', selectedHex: 32 };
window.initialUnlocked = new Set([11,12,13,20,21,22,29,30,31,38,39,40,47,48]);
window.state.unlockedTilesSet = new Set();

const \$ = (selector) => document.querySelector(selector);
const toast = (message) => { 
  const el = \$('#toast'); 
  el.textContent = message; 
  el.classList.add('visible'); 
  clearTimeout(window.toastTimer); 
  window.toastTimer = setTimeout(() => el.classList.remove('visible'), 2800); 
};

// Vector canvas engine dataset synchronizer properties triggers
function updateMapLayerState() {
  if (!window.tourtleMap || !window.tourtleMap.getSource('hex-grid')) return;
  
  const source = window.tourtleMap.getSource('hex-grid');
  const currentData = source._data;
  const activatedTiles =;

  currentData.features.forEach((feature) => {
    const idx = feature.properties.index;
    
    let status = 'unclaimed';
    if (window.initialUnlocked.has(idx)) {
      status = 'unlocked';
    } else if (activatedTiles.includes(idx)) {
      status = 'activated';
    }
    
    if (window.state.unlockedTilesSet && window.state.unlockedTilesSet.has(idx)) {
      status = 'unlocked';
    }

    feature.properties.status = status;
    feature.properties.isCurrent = (idx === window.state.selectedHex);
  });

  source.setData(currentData);
}

window.selectHex = function(index) {
  window.state.selectedHex = index;
  updateMapLayerState();
  
  const activatedTiles =;
  let status = 'unclaimed';
  
  if (window.initialUnlocked.has(index) || window.state.unlockedTilesSet.has(index)) {
    status = 'unlocked';
  } else if (activatedTiles.includes(index)) {
    status = 'activated';
  }

  if (status === 'unlocked') {
    toast('This tile is already part of your story.');
  } else {
    toast(`Tile zone #${index} selected — 68% toward unlock progress.`);
  }
};

function updateStats() {
  const coverage = Math.round((window.state.unlocked / window.state.total) * 100);
  \$('#unlockedCount').textContent = window.state.unlocked;
  \$('#coveragePercent').textContent = `${coverage}%`;
  \$('#coverageBar').style.width = `${coverage}%`;
  \$('#tileProgressBar').style.width = `${window.state.tileProgress}%`;
  \$('#todayProgress').textContent = `${window.state.today}%`;
  \$('#streakCount').textContent = window.state.streak;
  \$('#activityCount').textContent = `${window.state.activities} activities`;
  \$('#remainingMinutes').textContent = window.state.tileProgress >= 100 ? 'unlocked!' : `${Math.max(1, Math.ceil((100 - window.state.tileProgress) / 11))} more minutes`;
}

function addProgress(amount = 11) {
  window.state.tileProgress = Math.min(100, window.state.tileProgress + amount);
  window.state.today = Math.min(100, window.state.today + 4);
  
  if (window.state.tileProgress >= 100) {
    window.state.unlockedTilesSet.add(window.state.selectedHex);
    window.state.unlocked += 1; 
    window.state.tileProgress = 0; 
    window.state.streak = Math.max(window.state.streak, 5);
    toast('Tile unlocked! A little everyday movement goes a long way.');
  } else {
    toast(`Fog cleared — area is now ${window.state.tileProgress}% explored.`);
  }
  updateMapLayerState();
  updateStats();
}

\$('#trackingButton').addEventListener('click', () => {
  window.state.tracking = !window.state.tracking;
  \$('#trackingButton').classList.toggle('live', window.state.tracking);
  \$('#trackingButton').setAttribute('aria-pressed', String(window.state.tracking));
  \$('#trackingLabel').textContent = window.state.tracking ? 'Fog clearing on' : 'Fog clearing off';
  toast(window.state.tracking ? 'Prototype tracking is on. Use + to simulate a location update.' : 'Fog clearing paused.');
});

\$('#quickProgressButton').addEventListener('click', () => addProgress());
\$('#refreshButton').addEventListener('click', () => { 
  \$('#refreshButton').animate([{transform:'rotate(0deg)'},{transform:'rotate(360deg)'}],{duration:500}); 
  if (window.state.tracking) addProgress(6); else toast('Turn on fog clearing to catch up your map.'); 
});

\$('#recenterButton').addEventListener('click', () => { 
  window.dispatchEvent(new Event('tourtle:recenter')); 
  toast('Map centered on Hyderabad.'); 
});

\$('#tileInfoButton').addEventListener('click', () => toast('Zone Info: Selected tile data synchronized.'));
\$('#leaderboardButton').addEventListener('click', () => toast('The pilot leaderboard stays private to invited testers.'));

let captureType = 'photo';
document.querySelectorAll('[data-capture]').forEach((button) => button.addEventListener('click', () => {
  captureType = button.dataset.capture;
  const copy = {
    photo:['Capture a moment','This prototype saves a photo-style Activity and boosts your current tile.'],
    voice:['Leave a voice note','This prototype saves a voice-note Activity and boosts your current tile.'],
    session:['Start an outing','Your outing starts now. Save it later to grant each touched prototype tile a boost.']
  }[captureType];
  \$('#dialogTitle').textContent = copy[0]; 
  \$('#dialogCopy').textContent = copy[1]; 
  \$('#activityDialog').showModal();
}));

document.querySelectorAll('.category').forEach((button) => button.addEventListener('click', () => { 
  document.querySelectorAll('.category').forEach((item) => item.classList.remove('selected')); 
  button.classList.add('selected'); 
  window.state.category = button.dataset.category; 
}));

\$('#activityForm').addEventListener('submit', (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault(); 
  \$('#activityDialog').close(); 
  window.state.activities += 1; 
  addProgress(captureType === 'session' ? 18 : 26); 
  toast(`${window.state.category} Activity saved — your tile received a boost.`); 
  updateStats();
});

\$('#profileButton').addEventListener('click', () => toast('Aarav’s profile — personal territory is never shared by default.'));

// Trigger initialization load
updateStats();
