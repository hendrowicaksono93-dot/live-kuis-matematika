const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public/host.html')));
app.get('/play', (req, res) => res.sendFile(path.join(__dirname, 'public/play.html')));

const rooms = {};

// Fungsi Pembuat Soal Acak (4 Kategori)
function generateQuestion() {
  const type = Math.floor(Math.random() * 4) + 1;

  if (type === 1) {
    let n1 = Math.floor(Math.random() * 20) + 10;
    let n2 = Math.floor(Math.random() * 20) + 10;
    let n3 = Math.floor(Math.random() * 20) + 10;
    let op1 = Math.random() > 0.5 ? '+' : '-';
    let op2 = Math.random() > 0.5 ? '+' : '-';
    let expr = `${n1} ${op1} ${n2}`;
    let mid = eval(expr);
    if (mid < 0) { op1 = '+'; expr = `${n1} + ${n2}`; mid = n1 + n2; }
    let finalExpr = `${expr} ${op2} ${n3}`;
    let ans = eval(finalExpr);
    if (ans < 0) { op2 = '+'; finalExpr = `${expr} + ${n3}`; ans = mid + n3; }
    return { questionText: `${finalExpr} = ?`, correctAnswer: ans, duration: 15, category: 'Campuran Puluhan (+/-)' };
  } else if (type === 2) {
    let n1 = Math.floor(Math.random() * 8) + 2;
    let n2 = Math.floor(Math.random() * 8) + 2;
    return { questionText: `${n1} × ${n2} = ?`, correctAnswer: n1 * n2, duration: 10, category: 'Perkalian 1 Digit' };
  } else if (type === 3) {
    let n1 = Math.floor(Math.random() * 90) + 10;
    let n2 = Math.floor(Math.random() * 8) + 2;
    return { questionText: `${n1} × ${n2} = ?`, correctAnswer: n1 * n2, duration: 15, category: 'Perkalian 2×1 Digit' };
  } else {
    let divisor = Math.floor(Math.random() * 8) + 2;
    let quotient = Math.floor(Math.random() * 10) + 2;
    let dividend = divisor * quotient;
    while (dividend < 10 || dividend > 99) {
      quotient = Math.floor(Math.random() * 10) + 2;
      dividend = divisor * quotient;
    }
    return { questionText: `${dividend} ÷ ${divisor} = ?`, correctAnswer: quotient, duration: 12, category: 'Pembagian 2×1 Digit' };
  }
}

io.on('connection', (socket) => {
  console.log('User terhubung:', socket.id);

  socket.on('create_room', (roomId) => {
    rooms[roomId] = { hostId: socket.id, players: {}, currentQuestion: null, startTime: null, answers: [], timer: null };
    socket.join(roomId);
    socket.emit('room_created', roomId);
  });

  socket.on('join_room', ({ roomId, username }) => {
    if (!rooms[roomId]) return socket.emit('join_error', 'Kode Room tidak ditemukan!');
    rooms[roomId].players[socket.id] = { name: username, score: 0 };
    socket.join(roomId);
    socket.emit('joined_successfully', { username, roomId });
    io.to(rooms[roomId].hostId).emit('player_list_updated', Object.values(rooms[roomId].players));
  });

  // Host memicu kuis untuk pertama kali, setelah itu otomatis berjalan
  socket.on('start_question', (roomId) => {
    startNextQuestion(roomId);
  });

  function startNextQuestion(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const q = generateQuestion();
    room.currentQuestion = q;
    room.startTime = Date.now();
    room.answers = [];

    io.to(roomId).emit('new_question', {
      questionText: q.questionText,
      duration: q.duration,
      category: q.category
    });

    clearTimeout(room.timer);
    room.timer = setTimeout(() => {
      processRoundResults(roomId);
    }, q.duration * 1000);
  }

  socket.on('submit_answer', ({ roomId, answer }) => {
    const room = rooms[roomId];
    if (!room || !room.currentQuestion) return;

    const player = room.players[socket.id];
    if (!player) return;

    const latency = Date.now() - room.startTime;
    const isCorrect = parseInt(answer) === room.currentQuestion.correctAnswer;

    const alreadyAnswered = room.answers.find(a => a.socketId === socket.id);
    if (!alreadyAnswered) {
      room.answers.push({ socketId: socket.id, name: player.name, isCorrect, latency });
      socket.emit('answer_received', { isCorrect });
    }
  });

  function processRoundResults(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const correctAnswers = room.answers.filter(a => a.isCorrect).sort((a, b) => a.latency - b.latency);

    let fastest = null;
    if (correctAnswers.length > 0) {
      fastest = correctAnswers[0];
      correctAnswers.forEach(c => {
        if (room.players[c.socketId]) room.players[c.socketId].score += 1;
      });
    }

    const leaderboard = Object.values(room.players).sort((a, b) => b.score - a.score).slice(0, 10);

    io.to(room.hostId).emit('round_results', {
      correctAnswer: room.currentQuestion.correctAnswer,
      fastestName: fastest ? fastest.name : 'Tidak Ada',
      fastestTime: fastest ? (fastest.latency / 1000).toFixed(2) + 's' : '-',
      leaderboard
    });

    // SISTEM OTOMATIS: Lanjut soal berikutnya setelah jeda 5 detik
    setTimeout(() => {
      if (rooms[roomId]) startNextQuestion(roomId);
    }, 5000);
  }

  socket.on('disconnect', () => {
    console.log('User terputus:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server berjalan di http://localhost:${PORT}`));