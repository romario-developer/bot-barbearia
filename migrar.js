// ==========================================
// SCRIPT DE MIGRACAO - RODAR UMA VEZ NO SERVIDOR
//
//   node migrar.js
//   npx prisma generate
//   npx prisma db push
//   pm2 restart bot-barbearia
//
// Faz duas coisas:
//   1) Remove horarios duplicados (mesma data + mesma hora) da versao antiga.
//      Sem isso a regra @@unique([data, hora]) nao consegue ser aplicada.
//   2) Adota os agendamentos antigos: eles nao tinham grupoId nem chatId,
//      entao ficariam de fora dos lembretes e do pedido de avaliacao.
// ==========================================

const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const prisma = new PrismaClient();

const BLOCO_MINUTOS = 15;
const CLIENTES_IGNORADOS = ['ALMOÇO', 'ALMOCO', 'Presencial/Balcão', 'Presencial/Balcao', 'Presencial'];

function paraData(dataStr, horaStr) {
    const [d, m, y] = String(dataStr).split('/').map(Number);
    const [hh, mm] = String(horaStr).split(':').map(Number);
    return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0);
}

// ------------------------------------------
// ETAPA 1: duplicados
// ------------------------------------------
async function removerDuplicados() {
    console.log('ETAPA 1 - Procurando horarios duplicados...');

    const todos = await prisma.horario.findMany({ orderBy: { id: 'asc' } });
    const vistos = new Map();
    const paraApagar = [];

    for (const h of todos) {
        const chave = `${h.data}|${h.hora}`;
        const anterior = vistos.get(chave);

        if (!anterior) { vistos.set(chave, h); continue; }

        // Entre duplicados, mantem o que tem cliente de verdade
        const anteriorVale = anterior.status === 'ocupado' && anterior.cliente;
        const atualVale = h.status === 'ocupado' && h.cliente;

        if (atualVale && !anteriorVale) {
            paraApagar.push(anterior.id);
            vistos.set(chave, h);
        } else {
            paraApagar.push(h.id);
        }
    }

    if (paraApagar.length === 0) {
        console.log('  Nenhum duplicado encontrado.\n');
        return;
    }

    const r = await prisma.horario.deleteMany({ where: { id: { in: paraApagar } } });
    console.log(`  ${r.count} horarios duplicados removidos.\n`);
}

// ------------------------------------------
// ETAPA 2: adotar agendamentos antigos
// ------------------------------------------
async function adotarAgendamentosAntigos() {
    console.log('ETAPA 2 - Adotando agendamentos antigos...');

    let antigos;
    try {
        antigos = await prisma.horario.findMany({
            where: { status: 'ocupado', grupoId: null },
            orderBy: [{ data: 'asc' }, { hora: 'asc' }]
        });
    } catch (err) {
        console.log('  As colunas novas ainda nao existem no banco.');
        console.log('  Rode "npx prisma db push" e depois "node migrar.js" de novo para esta etapa.\n');
        return;
    }

    const reais = antigos.filter(h =>
        h.whatsapp &&
        h.whatsapp !== 'Painel Web' &&
        !CLIENTES_IGNORADOS.includes(h.cliente)
    );

    if (reais.length === 0) {
        console.log('  Nenhum agendamento antigo precisando de ajuste.\n');
        return;
    }

    // Agrupa blocos seguidos do mesmo cliente/servico no mesmo dia
    const grupos = [];
    let atual = null;

    for (const h of reais) {
        const mesmaPessoa = atual &&
            atual.data === h.data &&
            atual.whatsapp === h.whatsapp &&
            atual.cliente === h.cliente &&
            atual.servico === h.servico;

        const seguido = mesmaPessoa &&
            (paraData(h.data, h.hora) - paraData(atual.data, atual.ultimaHora)) === BLOCO_MINUTOS * 60000;

        if (seguido) {
            atual.ids.push(h.id);
            atual.ultimaHora = h.hora;
        } else {
            atual = {
                data: h.data, hora: h.hora, ultimaHora: h.hora,
                whatsapp: h.whatsapp, cliente: h.cliente, servico: h.servico,
                ids: [h.id]
            };
            grupos.push(atual);
        }
    }

    const agora = new Date();
    let futuros = 0, passados = 0;

    for (const g of grupos) {
        const jaPassou = paraData(g.data, g.ultimaHora) < agora;

        await prisma.horario.updateMany({
            where: { id: { in: g.ids } },
            data: {
                grupoId: crypto.randomUUID(),
                chatId: `${g.whatsapp}@c.us`,
                // Agendamento que ja passou nao deve disparar lembrete nem avaliacao agora
                lembreteEnviado: jaPassou,
                feedbackEnviado: jaPassou
            }
        });

        if (jaPassou) passados++; else futuros++;
    }

    console.log(`  ${grupos.length} agendamentos adotados (${futuros} futuros, ${passados} ja passados).`);
    if (futuros > 0) console.log(`  Os ${futuros} futuros vao receber lembrete e pedido de avaliacao normalmente.`);
    console.log('');
}

// ------------------------------------------
async function main() {
    console.log('\n=== MIGRACAO DO BOT DA BARBEARIA ===\n');

    await removerDuplicados();
    await adotarAgendamentosAntigos();

    const total = await prisma.horario.count();
    const ocupados = await prisma.horario.count({ where: { status: 'ocupado' } });
    const servicos = await prisma.servico.count();

    console.log('=== SITUACAO ATUAL ===');
    console.log(`  Horarios na agenda: ${total} (${ocupados} ocupados)`);
    console.log(`  Servicos cadastrados: ${servicos}`);
    console.log('\nProximo passo: npx prisma generate && npx prisma db push\n');
}

main()
    .catch(e => { console.error('Erro na migracao:', e.message); process.exit(1); })
    .finally(() => prisma.$disconnect());
