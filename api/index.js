import { Redis } from '@upstash/redis';
import Pusher from 'pusher';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true,
});

// Generator Soal Acak
function generateQuestion() {
  const categories = ['Mudah', 'Sedang', 'Sulit'];
  const category = categories[Math.floor(Math.random() * categories.length)];
  let num1, num2, operator, correctAnswer, duration;

  if (category === 'Mudah') {
    num1 = Math.floor(Math.random() * 20) + 1;
    num2 = Math.floor(Math.random() * 20) + 1;
    operator = Math.random() > 0.5 ? '+' : '-';
    correctAnswer = operator === '+' ? num1 + num2 : num1 - num2;
    duration = 10;
  } else if (category === 'Sedang') {
    num1 = Math.floor(Math.random() * 12) + 2;
    num2 = Math.floor(Math.random() * 12) + 2;
    operator = '×';
    correctAnswer = num1 * num2;
    duration = 15;
  } else {
    num2 = Math.floor(Math.random() * 10) + 2;
    correctAnswer = Math.floor(Math.random() * 10) + 2;
    num1 = num2 * correctAnswer;
    operator = '÷';
    duration = 20;
  }

  return {
    questionText: `${num1} ${operator} ${num2} = ?`,
    correctAnswer: String(correctAnswer),
    category,
    duration,
    startTime: Date.now()
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { action, roomId, userId, username, answer } = req.body;

  try {
    if (action === 'create_room') {
      let room = await redis.get(`room:${roomId}`);
      if (!room) {
        room = { roomId, players: {}, answers: [], currentQuestion: null };
        await redis.set(`room:${roomId}`, room);
      }
      return res.status(200).json({ success: true, room });
    }

    if (action === 'join_room') {
      let room = await redis.get(`room:${roomId}`);
      if (!room) return res.status(404).json({ error: 'Room tidak ditemukan' });

      room.players[userId] = { name: username, score: 0 };
      await redis.set(`room:${roomId}`, room);
      return res.status(200).json({ success: true });
    }

    if (action === 'start_question') {
      let room = await redis.get(`room:${roomId}`);
      if (!room) return res.status(404).json({ error: 'Room tidak ditemukan' });

      const q = generateQuestion();
      room.currentQuestion = q;
      room.answers = []; // Reset jawaban ronde ini

      await redis.set(`room:${roomId}`, room);

      await pusher.trigger(`room-${roomId}`, 'new_question', {
        questionText: q.questionText,
        category: q.category,
        duration: q.duration
      });

      return res.status(200).json({ success: true, question: q });
    }

    // PROSES JAWABAN REAL-TIME DARI SISWA
    if (action === 'submit_answer') {
      let room = await redis.get(`room:${roomId}`);
      if (!room || !room.currentQuestion) return res.status(404).json({ error: 'Room atau soal tidak aktif' });

      const latency = Date.now() - room.currentQuestion.startTime;
      const isCorrect = String(answer).trim() === String(room.currentQuestion.correctAnswer).trim();

      const existingIdx = room.answers.findIndex(a => a.userId === userId);
      const player = room.players[userId];
      const playerName = player ? player.name : (username || 'Siswa');

      const answerData = { userId, name: playerName, answer, isCorrect, latency };

      if (existingIdx >= 0) {
        room.answers[existingIdx] = answerData;
      } else {
        room.answers.push(answerData);
      }

      // Ambil daftar jawaban benar & urutkan berdasarkan kecepatan
      const correctAnswers = room.answers
        .filter(a => a.isCorrect)
        .sort((a, b) => a.latency - b.latency);

      const fastestList = correctAnswers.slice(0, 10).map(c => ({
        name: c.name,
        time: (c.latency / 1000).toFixed(2) + 's'
      }));

      const fastest = correctAnswers[0] || null;

      await redis.set(`room:${roomId}`, room);

      // BROADCAST KELUARAN SECARA LANGSUNG KE LAYAR HOST
      await pusher.trigger(`room-${roomId}`, 'fastest_update', {
        fastestName: fastest ? fastest.name : 'Tidak Ada',
        fastestTime: fastest ? (fastest.latency / 1000).toFixed(2) + 's' : '-',
        fastestList
      });

      return res.status(200).json({ success: true, isCorrect });
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
      const allPlayers = Object.values(room.players).sort((a, b) => b.score - a.score);

      const leaderboard = Object.values(room.players).sort((a, b) => b.score - a.score).slice(0, 10);
      
      const fastestList = correctAnswers.slice(0, 10).map(c => ({
        name: c.name,
        time: (c.latency / 1000).toFixed(2) + 's'
      }));

      await redis.set(`room:${roomId}`, room);

      await pusher.trigger(`room-${roomId}`, 'round_results', {
        correctAnswer: room.currentQuestion.correctAnswer,
        fastestName: fastest ? fastest.name : 'Tidak Ada',
        fastestTime: fastest ? (fastest.latency / 1000).toFixed(2) + 's' : '-',
        fastestList,
        leaderboard,
        allPlayers
      });

      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Action tidak dikenal' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}