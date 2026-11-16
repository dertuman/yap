// Plays a scripted call into the command center, as text (fast, tests the brain) or as
// audio through the local whisper-server (tests transcription too, uses macOS `say`).
//   node callpilot/simulate.mjs [--url http://127.0.0.1:8768] [--audio] [--speed 3] [--end] [--recap]
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const flag = (n) => process.argv.includes('--' + n);
const val = (n, d) => (process.argv.includes('--' + n) ? process.argv[process.argv.indexOf('--' + n) + 1] : d);
let url = val('url');
if (!url) {
  try { url = JSON.parse(readFileSync(join(process.env.HOME, '.config/yap/callpilot.json'), 'utf8')).url; } catch { url = 'http://127.0.0.1:8768'; }
}
const speed = Number(val('speed', 3));
const post = (p, b, raw) =>
  fetch(url + p, { method: 'POST', headers: raw ? {} : { 'content-type': 'application/json' }, body: raw ? b : JSON.stringify(b) }).then((r) => r.json());

// A call with a clinic client: small talk, a settled change, an open debate, a price, an export, a to-do.
const SCRIPT = [
  ['them', 'Hola Alex, ¿qué tal? ¿Me escuchas bien?'],
  ['me', 'Sí, perfecto, te escucho súper bien. ¿Cómo va todo en la clínica?'],
  ['them', 'Bien, bien, mucho trabajo esta semana con la campaña de vacunación de influenza.'],
  ['me', 'Qué bueno. Oye, quería platicar de los recordatorios de WhatsApp de la agenda.'],
  ['them', 'Sí, mira, el problema es que el recordatorio llega el mismo día en la mañana y muchos pacientes ya hicieron planes.'],
  ['them', 'Lo ideal sería que llegue un día antes, como a las seis de la tarde, y luego otro dos horas antes de la cita.'],
  ['me', 'Ok, so two reminders: one the day before at 6 pm, and one two hours before. Is that the same for boosters?'],
  ['them', 'Sí, igual para los refuerzos. Y que el mensaje diga el nombre del doctor, porque a veces no saben con quién van.'],
  ['me', 'Perfecto, vale, eso lo cambiamos. Day before at 6 pm, two hours before, and the doctor name in the message.'],
  ['them', 'Órale, va. Otra cosa, ¿cuánto nos costaría agregar el módulo de facturación?'],
  ['me', 'Mira, el módulo de facturación con el CFDI sería un pago único de veinticinco mil pesos más quinientos al mes por el timbrado.'],
  ['them', 'Mmm, ¿y si lo pagamos en dos partes? Doce mil quinientos ahora y el resto cuando esté en producción.'],
  ['me', 'Sí, me parece bien, lo hacemos en dos pagos. Pero el mensual empieza cuando salga a producción.'],
  ['them', 'Perfecto, trato hecho.'],
  ['them', 'Also, our accountant needs an export of all appointments from last month, with patient, vaccine, date and the doctor, in Excel or CSV.'],
  ['me', 'Easy. I can add an export button in the agenda, filtered by date range, CSV. Do you need it this week?'],
  ['them', 'Si puede ser para el viernes, mejor, porque cerramos mes.'],
  ['me', 'Va, para el viernes lo tienes. CSV con paciente, vacuna, fecha y doctor, con filtro de fechas.'],
  ['them', 'Y una pregunta, ¿deberíamos cambiar el color de la app? A la doctora no le gusta tanto el azul.'],
  ['me', 'Podemos verlo, pero yo creo que el azul funciona. ¿Qué color tenía en mente?'],
  ['them', 'No sé, algo más verde, pero déjame preguntarle bien y te digo.'],
  ['me', 'Ok, cuando me digas lo vemos. Por cierto, I need to call your accountant about the CFDI setup, can you send me his number?'],
  ['them', 'Sí, te lo mando por WhatsApp ahorita. Se llama Ricardo Mendoza.'],
  ['me', 'Perfecto, I will call Ricardo tomorrow morning then.'],
  ['them', 'Muy bien Alex, muchas gracias, hablamos el viernes.'],
  ['me', 'Gracias a ti, nos vemos.'],
];

async function main() {
  const call = await post('/api/calls/start', { recap: flag('recap') });
  console.log('call', call.id, 'on', url);
  const dir = mkdtempSync(join(tmpdir(), 'yap-sim-'));
  for (const [i, [speaker, text]] of SCRIPT.entries()) {
    const dur = Math.max(1500, text.split(' ').length * 380);
    if (flag('audio')) {
      const aiff = join(dir, `${i}.aiff`);
      const wav = join(dir, `${i}.wav`);
      const voice = /[áéíóúñ¿¡]|\b(que|el|la|es|sí|para|con|lo)\b/i.test(text) ? (speaker === 'me' ? 'Jorge' : 'Paulina') : speaker === 'me' ? 'Daniel' : 'Samantha';
      try { execFileSync('say', ['-v', voice, '-o', aiff, text]); } catch { execFileSync('say', ['-o', aiff, text]); }
      execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
      await post(`/api/audio?stream=${speaker}&t0=${Date.now()}&dur=${dur}`, readFileSync(wav), true);
    } else {
      await post('/api/segments', { speaker, text, t: Date.now(), dur });
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, dur / speed));
  }
  console.log('\nscript done');
  if (flag('end')) {
    await new Promise((r) => setTimeout(r, 4000));
    await post('/api/calls/end', {});
    console.log('ended');
  }
}
main();
