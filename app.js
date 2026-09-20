const state = { unlocked: 14, total: 78, tileProgress: 68, today: 32, streak: 4, activities: 2, tracking: false, category: 'Dining', selectedHex: 32 };
const $ = (selector) => document.querySelector(selector);
const toast = (message) => { const el = $('#toast'); el.textContent = message; el.classList.add('visible'); clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => el.classList.remove('visible'), 2800); };

const grid = { columns: 9, rows: 7, width: 90, height: 104, xPitch: 91, yPitch: 79, rowOffset: 45.5 };
const initialUnlocked = new Set([11,12,13,20,21,22,29,30,31,38,39,40,47,48]);
const cellIndex = (column, row) => row * grid.columns + column;
const cellPosition = (column, row) => ({
  x: column * grid.xPitch + (row % 2) * grid.rowOffset,
  y: row * grid.yPitch,
});

function neighbours(column, row) {
  const diagonalColumn = row % 2 === 0
    ? { ne: column, nw: column - 1, se: column, sw: column - 1 }
    : { ne: column + 1, nw: column, se: column + 1, sw: column };
  return [
    [column, row - 1, 'nw'], [column + 1, row, 'east'], [column, row + 1, 'sw'],
    [column - 1, row + 1, 'se'], [column - 1, row, 'west'], [column - 1, row - 1, 'ne'],
  ].map(([c, r, edge]) => {
    if (edge === 'nw') c = diagonalColumn.ne;
    if (edge === 'ne') c = diagonalColumn.nw;
    if (edge === 'sw') c = diagonalColumn.se;
    if (edge === 'se') c = diagonalColumn.sw;
    return [c, r];
  });
}

function renderUnlockedBorders() {
  const layer = $('#unlockedBorders');
  if (!layer) return;
  layer.replaceChildren();
  const cells = [...document.querySelectorAll('.hex.unlocked')];
  const unlocked = new Set(cells.map((cell) => Number(cell.dataset.index)));
  const vertices = (column, row) => {
    const { x, y } = cellPosition(column, row);
    return [[x + 45, y], [x + 90, y + 26], [x + 90, y + 78], [x + 45, y + 104], [x, y + 78], [x, y + 26]];
  };
  cells.forEach((cell) => {
    const index = Number(cell.dataset.index);
    const column = index % grid.columns;
    const row = Math.floor(index / grid.columns);
    const points = vertices(column, row);
    neighbours(column, row).forEach(([neighborColumn, neighborRow], edge) => {
      if (neighborColumn < 0 || neighborColumn >= grid.columns || neighborRow < 0 || neighborRow >= grid.rows || !unlocked.has(cellIndex(neighborColumn, neighborRow))) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', points[edge][0]);
        line.setAttribute('y1', points[edge][1]);
        line.setAttribute('x2', points[(edge + 1) % 6][0]);
        line.setAttribute('y2', points[(edge + 1) % 6][1]);
        layer.appendChild(line);
      }
    });
  });
}

function buildMap() {
  const map = $('#hexMap');
  const borderLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  borderLayer.setAttribute('id', 'unlockedBorders');
  borderLayer.setAttribute('viewBox', '0 0 865 600');
  borderLayer.setAttribute('aria-hidden', 'true');
  borderLayer.classList.add('unlocked-borders');
  map.appendChild(borderLayer);
  for (let i = 0; i < 63; i++) {
    const hex = document.createElement('button');
    hex.className = 'hex unclaimed';
    hex.type = 'button';
    if (initialUnlocked.has(i)) hex.className = 'hex unlocked';
    if ([3,4,5,10,14,19,23,28,32,37,41,46,49,55].includes(i)) hex.className = 'hex activated';
    if (i === state.selectedHex) hex.classList.add('current');
    hex.dataset.index = i;
    const column = i % 9;
    const row = Math.floor(i / 9);
    // True pointy-top honeycomb: each row is offset half a hex wide.
    // The 1px surplus in the horizontal and vertical pitch is the hairline gap.
    hex.style.setProperty('--x', `${column * 91 + (row % 2) * 45.5}px`);
    hex.style.setProperty('--y', `${row * 79}px`);
    hex.setAttribute('aria-label', hex.classList.contains('unlocked') ? 'Unlocked tile' : hex.classList.contains('activated') ? 'Activated tile, 68 percent complete' : 'Unclaimed tile');
    hex.addEventListener('click', () => selectHex(i));
    map.appendChild(hex);
  }
  renderUnlockedBorders();
}
function selectHex(index) {
  state.selectedHex = index;
  document.querySelectorAll('.hex').forEach((hex) => hex.classList.toggle('current', Number(hex.dataset.index) === index));
  const choice = document.querySelector(`.hex[data-index="${index}"]`);
  if (choice.classList.contains('unlocked')) toast('This tile is already part of your story.');
  else { choice.classList.add('activated'); toast('Begumpet tile selected — 68% toward unlock.'); }
}
function updateStats() {
  const coverage = Math.round((state.unlocked / state.total) * 100);
  $('#unlockedCount').textContent = state.unlocked;
  $('#coveragePercent').textContent = `${coverage}%`;
  $('#coverageBar').style.width = `${coverage}%`;
  $('#tileProgressBar').style.width = `${state.tileProgress}%`;
  $('#todayProgress').textContent = `${state.today}%`;
  $('#streakCount').textContent = state.streak;
  $('#activityCount').textContent = state.activities;
  $('#remainingMinutes').textContent = state.tileProgress >= 100 ? 'unlocked!' : `${Math.max(1, Math.ceil((100 - state.tileProgress) / 11))} more minutes`;
}
function addProgress(amount = 11) {
  state.tileProgress = Math.min(100, state.tileProgress + amount);
  state.today = Math.min(100, state.today + 4);
  const current = document.querySelector(`.hex[data-index="${state.selectedHex}"]`);
  current.classList.add('activated');
  if (state.tileProgress >= 100) {
    current.classList.remove('activated'); current.classList.add('unlocked');
    state.unlocked += 1; state.tileProgress = 0; state.streak = Math.max(state.streak, 5);
    renderUnlockedBorders();
    toast('Tile unlocked! A little everyday movement goes a long way.');
  } else toast(`Fog cleared — Begumpet is now ${state.tileProgress}% explored.`);
  updateStats();
}
$('#trackingButton').addEventListener('click', () => {
  state.tracking = !state.tracking;
  $('#trackingButton').classList.toggle('live', state.tracking);
  $('#trackingButton').setAttribute('aria-pressed', String(state.tracking));
  $('#trackingLabel').textContent = state.tracking ? 'Fog clearing on' : 'Fog clearing off';
  toast(state.tracking ? 'Prototype tracking is on. Use + to simulate a location update.' : 'Fog clearing paused.');
});
$('#quickProgressButton').addEventListener('click', () => addProgress());
$('#refreshButton').addEventListener('click', () => { $('#refreshButton').animate([{transform:'rotate(0deg)'},{transform:'rotate(360deg)'}],{duration:500}); if (state.tracking) addProgress(6); else toast('Turn on fog clearing to catch up your map.'); });
$('#recenterButton').addEventListener('click', () => { $('#userDot').style.left = `${45 + Math.floor(Math.random() * 12)}%`; $('#userDot').style.top = `${42 + Math.floor(Math.random() * 14)}%`; window.dispatchEvent(new Event('tourtle:recenter')); toast('Map centered on Hyderabad.'); });
$('#tileInfoButton').addEventListener('click', () => toast('Begumpet: activated, with 68% dwell progress.'));
$('#leaderboardButton').addEventListener('click', () => toast('The pilot leaderboard stays private to invited testers.'));

let captureType = 'photo';
document.querySelectorAll('[data-capture]').forEach((button) => button.addEventListener('click', () => {
  captureType = button.dataset.capture;
  const copy = {photo:['Capture a moment','This prototype saves a photo-style Activity and boosts your current tile.'],voice:['Leave a voice note','This prototype saves a voice-note Activity and boosts your current tile.'],session:['Start an outing','Your outing starts now. Save it later to grant each touched prototype tile a boost.']}[captureType];
  $('#dialogTitle').textContent = copy[0]; $('#dialogCopy').textContent = copy[1]; $('#activityDialog').showModal();
}));
document.querySelectorAll('.category').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('.category').forEach((item) => item.classList.remove('selected')); button.classList.add('selected'); state.category = button.dataset.category; }));
$('#activityForm').addEventListener('submit', (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault(); $('#activityDialog').close(); state.activities += 1; addProgress(captureType === 'session' ? 18 : 26); toast(`${state.category} Activity saved — your tile received a boost.`); updateStats();
});
$('#profileButton').addEventListener('click', () => toast('Aarav’s profile — personal territory is never shared by default.'));
buildMap(); updateStats();
