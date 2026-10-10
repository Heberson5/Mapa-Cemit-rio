// Dados de DEMONSTRAÇÃO – layout fictício para visualizar o sistema funcionando.
// Tudo é marcado demo=1 e pode ser apagado em Configurações → "Apagar dados de demonstração".
const NAMES = ['Maria', 'José', 'Ana', 'João', 'Antônio', 'Francisca', 'Raimundo', 'Luiza', 'Pedro', 'Aparecida', 'Sebastião', 'Rita', 'Manoel', 'Terezinha', 'Joaquim', 'Helena', 'Osvaldo', 'Marlene', 'Geraldo', 'Dirce', 'Valdemar', 'Neusa', 'Adão', 'Cleusa'];
const SURN = ['Silva', 'Souza', 'Oliveira', 'Santos', 'Pereira', 'Ferreira', 'Almeida', 'Rodrigues', 'Costa', 'Gomes', 'Martins', 'Lima', 'Araújo', 'Ribeiro', 'Carvalho', 'Barbosa', 'Dias', 'Moreira', 'Cardoso', 'Rocha'];

export function seedDemo({ db, TYPES, getConfig, setConfig, norm, tx }) {
  let s = 20260101; // PRNG determinístico
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const cfg = getConfig();
  const [lng0, lat0] = cfg.center;
  const mLat = 1 / 111320, mLng = 1 / (111320 * Math.cos((lat0 * Math.PI) / 180));
  // (x,y) em metros a partir do centro (x leste, y norte)
  const pt = (x, y) => [+(lng0 + x * mLng).toFixed(8), +(lat0 + y * mLat).toFixed(8)];
  const rect = (cx, cy, w, h, deg) => {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
    const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => pt(cx + x * c - y * sn, cy + x * sn + y * c));
    return { type: 'Polygon', coordinates: [[...pts, pts[0]]] };
  };

  const W = 240, H = 330; // terreno
  const boundary = { type: 'Polygon', coordinates: [[pt(-W / 2, -H / 2), pt(W / 2, -H / 2), pt(W / 2, H / 2), pt(-W / 2, H / 2), pt(-W / 2, -H / 2)]] };
  setConfig({ ...cfg, boundary, entrance: pt(0, -H / 2 + 4), zoom: 17.3 });

  const insPlot = db.prepare('INSERT INTO plots(code,type,alameda,quadra,lote,geometry,demo,reserved) VALUES(?,?,?,?,?,?,1,?)');
  const insDec = db.prepare('INSERT INTO deceased(name,name_norm,plot_id,drawer,kind,birth_date,death_date,event_date,responsible,phone,notes,demo) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)');
  const dateIn = (y0, y1) => `${y0 + Math.floor(rnd() * (y1 - y0 + 1))}-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`;
  const person = () => `${pick(NAMES)} ${pick(SURN)} ${pick(SURN)}`;

  function fill(plotId, type, occ) {
    const n = Math.min(occ, TYPES[type].cap);
    for (let d = 1; d <= n; d++) {
      const kindR = rnd();
      const kind = kindR < 0.07 ? 'cinzas' : kindR < 0.12 ? 'exumacao' : 'sepultamento';
      const death = dateIn(1998, 2026);
      const name = person();
      insDec.run(name, norm(name), plotId, d, kind, dateIn(1920, 1975), death, kind === 'sepultamento' ? death : dateIn(2000, 2026),
        person(), `(65) 9${Math.floor(1000 + rnd() * 8999)}-${Math.floor(1000 + rnd() * 8999)}`,
        kind === 'cinzas' ? 'Guarda de cinzas (urna)' : kind === 'exumacao' ? 'Exumação realizada' : '');
    }
  }

  tx(() => {
    // 4 quadras (A–D) na parte da frente, cada uma com alamedas; tipo varia por fileira
    const rowTypes = ['1G', '2G', '3G', '3GS', '6GS', '2G', '3G', '1G'];
    const blocks = [['A', -118, -150], ['B', 8, -150], ['C', -118, -95], ['D', 8, -95]];
    for (const [q, bx, by] of blocks) {
      const cols = 40, colW = 1.2 + 0.45;
      let y = by;
      for (let r = 0; r < rowTypes.length; r++) {
        const type = rowTypes[r], t = TYPES[type], rowH = t.h;
        const alameda = String(Math.floor(r / 2) + 1);
        for (let c = 0; c < cols; c++) {
          const x = bx + c * colW + colW / 2;
          const code = `${q}-${alameda}-${String(r * cols + c + 1).padStart(3, '0')}`;
          const reserved = rnd() < 0.05 ? 1 : 0;
          const id = Number(insPlot.run(code, type, `Alameda ${alameda}`, `Quadra ${q}`, String(r * cols + c + 1), JSON.stringify(rect(x, y + rowH / 2, t.w, rowH, 0)), reserved).lastInsertRowid);
          if (rnd() < 0.6) fill(id, type, 1 + Math.floor(rnd() * TYPES[type].cap));
        }
        y += rowH + (r % 2 === 1 ? 5 : 0.9); // alameda (corredor) a cada duas fileiras
      }
    }
    // Anfiteatro ao fundo + terrenos familiares ao redor (anéis de blocos 6 gavetas c/ área de serviço)
    const cx = 0, cy = 125;
    const rings = [[38, 16], [46, 20], [54, 24]];
    let n = 0;
    rings.forEach(([R, count], ri) => {
      for (let i = 0; i < count; i++) {
        const ang = Math.PI + (i + 0.5) * (Math.PI / count) * -1 + Math.PI; // semicírculo voltado para o fundo
        const a = Math.PI * (0.06 + (0.88 * i) / (count - 1));            // 0..π (lado norte)
        const x = cx + R * Math.cos(a), y = cy + R * Math.sin(a);
        const rot = (a * 180) / Math.PI - 90;
        n++;
        const id = Number(insPlot.run(`F-${String(n).padStart(2, '0')}`, 'FAM', `Anel ${ri + 1}`, 'Anfiteatro', String(n), JSON.stringify(rect(x, y, TYPES.FAM.w, TYPES.FAM.h, rot)), 0).lastInsertRowid);
        if (rnd() < 0.55) fill(id, 'FAM', 1 + Math.floor(rnd() * 6));
      }
    });
    // Histórico fictício de consultas no totem (45 dias) e respostas da pesquisa
    const decs = db.prepare("SELECT id,plot_id FROM deceased WHERE demo=1").all();
    const hot = decs.slice(0, 25); // alguns falecidos muito procurados
    const insEv = db.prepare('INSERT INTO events(ts,kind,term,results,deceased_id,plot_id,session,device) VALUES(?,?,?,?,?,?,?,?)');
    const stamp = (daysAgo) => { const d = new Date(Date.now() - 4 * 3600e3 - daysAgo * 864e5); const h = Math.min(18, Math.max(7, Math.round(13 + (rnd() + rnd() + rnd() - 1.5) * 6)));
      return `${d.toISOString().slice(0, 10)} ${String(h).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`; };
    for (let i = 0; i < 520; i++) {
      const d = rnd() < 0.35 ? pick(hot) : pick(decs), ts = stamp(Math.floor(rnd() * rnd() * 45 + rnd() * 10)), ses = 's' + i;
      insEv.run(ts, 'search', 'demo', 1 + Math.floor(rnd() * 5), null, null, ses, 'totem');
      insEv.run(ts, 'view', null, null, d.id, d.plot_id, ses, 'totem');
    }
    for (const t of ['joao da silva', 'maria', 'sebastiao lima', 'xyz']) for (let i = 0; i < 1 + Math.floor(rnd() * 4); i++) insEv.run(stamp(rnd() * 30), 'search', t, 0, null, null, 'm' + i, 'totem');
    const qIds = {};
    // Perguntas padrão da pesquisa (NPS + qualidade do ambiente)
    const q = db.prepare('INSERT INTO questions(text,type,options,category,active,position) VALUES(?,?,?,?,1,?)');
    q.run('De 0 a 10, o quanto você recomendaria o Memorial Santa Cruz a um amigo ou familiar?', 'nps', '[]', 'NPS', 1);
    q.run('Como você avalia a limpeza e conservação do cemitério?', 'stars', '[]', 'Ambiente', 2);
    q.run('Como você avalia o gramado e os jardins?', 'stars', '[]', 'Ambiente', 3);
    q.run('Como foi o atendimento da equipe?', 'stars', '[]', 'Atendimento', 4);
    q.run('Qual o motivo da sua visita hoje?', 'choice', JSON.stringify(['Visita a ente querido', 'Data comemorativa', 'Sepultamento', 'Informações / contrato', 'Outro']), 'Perfil', 5);
    q.run('Deixe uma sugestão ou comentário (opcional)', 'text', '[]', 'Comentários', 6);
    const qs = db.prepare('SELECT id,type FROM questions ORDER BY position').all();
    const insR = db.prepare('INSERT INTO responses(ts,session) VALUES(?,?)'), insA = db.prepare('INSERT INTO answers(response_id,question_id,value_num,value_text) VALUES(?,?,?,?)');
    const motivos = ['Visita a ente querido', 'Visita a ente querido', 'Data comemorativa', 'Sepultamento', 'Informações / contrato', 'Outro'];
    const coment = ['Local muito bem cuidado.', 'Faltam bancos na sombra.', 'Gostaria de mais iluminação à noite.', 'Excelente atendimento, obrigado!', 'O gramado estava alto perto da alameda 3.', 'Totem facilitou muito encontrar meu pai.'];
    for (let i = 0; i < 140; i++) {
      const rid = Number(insR.run(stamp(rnd() * rnd() * 45) + '', 'r' + i).lastInsertRowid);
      const nps = Math.max(0, Math.min(10, Math.round(8.4 + (rnd() + rnd() - 1) * 5)));
      insA.run(rid, qs[0].id, nps, null);
      insA.run(rid, qs[1].id, Math.max(1, Math.min(5, Math.round(4.2 + (rnd() - 0.6) * 2.4))), null);
      insA.run(rid, qs[2].id, Math.max(1, Math.min(5, Math.round(3.9 + (rnd() - 0.5) * 2.6))), null);
      insA.run(rid, qs[3].id, Math.max(1, Math.min(5, Math.round(4.5 + (rnd() - 0.6) * 2))), null);
      insA.run(rid, qs[4].id, null, pick(motivos));
      if (rnd() < 0.25) insA.run(rid, qs[5].id, null, pick(coment));
    }
  });
}
