const Pusher = require('pusher');
const { Redis } = require('@upstash/redis');

// Koneksi ke Pusher (Pengganti Socket.io)
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true
});

// Koneksi ke Upstash Redis (Pengganti RAM laptop)
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Fungsi Pembuat Soal (Sama persis dengan milikmu)
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

// Handler Vercel API
module.exports = async function(req, res) {
  // Hanya menerima metode POST
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metode tidak diizinkan' });

  const { action, roomId, userId, username, answer } = req.body;

  try {
    if (action === 'create_room') {
      await redis.set(`room:${roomId}`, { hostId: userId, players: {}, currentQuestion: null, startTime: null, answers: [] });
      return res.status(200).json({ success: true, roomId });
    }

    if (action === 'join_room') {
      let room = await redis.get(`room:${roomId}`);
      if (!room) return res.status(404).json({ error: 'Kode Room tidak ditemukan!' });

      room.players[userId] = { name: username, score: 0 };
      await redis.set(`room:${roomId}`, room);

      // Beri tahu host ada pemain masuk
      await pusher.trigger(`room-${roomId}`, 'player_joined', Object.values(room.players));
      return res.status(200).json({ success: true, username, roomId });
    }

    if (action === 'start_question') {
      let room = await redis.get(`room:${roomId}`);
      if (!room) return res.status(404).json({ error: 'Room tidak ditemukan' });

      const q = generateQuestion();
      room.currentQuestion = q;
      room.startTime = Date.now();
      room.answers = [];
      await redis.set(`room:${roomId}`, room);

      // Kirim soal ke semua HP siswa dan layar
      await pusher.trigger(`room-${roomId}`, 'new_question', {
        questionText: q.questionText,
        duration: q.duration,
        category: q.category
      });
      return res.status(200).json({ success: true, duration: q.duration });
    }

    if (action === 'submit_answer') {
      let room = await redis.get(`room:${roomId}`);
      if (!room || !room.currentQuestion) return res.status(400).json({ error: 'Tidak ada soal aktif' });

      const player = room.players[userId];
      if (!player) return res.status(400).json({ error: 'Pemain tidak ditemukan' });

      const latency = Date.now() - room.startTime;
      const isCorrect = parseInt(answer) === room.currentQuestion.correctAnswer;

      const alreadyAnswered = room.answers.find(a => a.userId === userId);
      if (!alreadyAnswered) {
        room.answers.push({ userId, name: player.name, isCorrect, latency });
        await redis.set(`room:${roomId}`, room);
        
        // Beri tahu siswa bahwa jawaban sudah diterima
        await pusher.trigger(`room-${roomId}`, 'answer_received', { userId, isCorrect });
      }
      return res.status(200).json({ success: true });
    }

    if (action === 'process_results') {
      let room = await redis.get(`room:${roomId}`);
      if (!room) return res.status(404).json({ error: 'Room tidak ditemukan' });

      const correctAnswers = room.answers.filter(a => a.isCorrect).sort((a, b) => a.latency - b.latency);
      let fastest = null;
      if (correctAnswers.length > 0) {
        fastest = correctAnswers[0];
        correctAnswers.forEach(c => {
          if (room.players[c.userId]) room.players[c.userId].score += 1;
        });
      }

      const leaderboard = Object.values(room.players).sort((a, b) => b.score - a.score).slice(0, 10);
      await redis.set(`room:${roomId}`, room);

      // Tampilkan hasil di layar proyektor
      await pusher.trigger(`room-${roomId}`, 'round_results', {
        correctAnswer: room.currentQuestion.correctAnswer,
        fastestName: fastest ? fastest.name : 'Tidak Ada',
        fastestTime: fastest ? (fastest.latency / 1000).toFixed(2) + 's' : '-',
        leaderboard
      });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Aksi tidak valid' });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Terjadi kesalahan pada server' });
  }
}