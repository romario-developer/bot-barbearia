// ==========================================
// SCRIPT DE MIGRACAO - RODAR UMA VEZ NO SERVIDOR
//
//   node migrar.js
//   npx prisma db push
//   pm2 restart bot-barbearia
//
// Remove horarios duplicados (mesma data + mesma hora) que existiam
// na versao antiga. Sem isso, a nova regra @@unique([data, hora])
// nao consegue ser aplicada no banco.
// ==========================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    console.log('Procurando horarios duplicados...\n');

    const todos = await prisma.horario.findMany({ orderBy: { id: 'asc' } });
    const vistos = new Map();
    const paraApagar = [];

    for (const h of todos) {
        const chave = `${h.data}|${h.hora}`;
        const anterior = vistos.get(chave);

        if (!anterior) {
            vistos.set(chave, h);
            continue;
        }

        // Entre duplicados, mantem o que esta ocupado (tem cliente de verdade)
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
        console.log('Nenhum duplicado encontrado. Pode rodar "npx prisma db push" com seguranca.');
    } else {
        console.log(`Encontrados ${paraApagar.length} horarios duplicados. Removendo...`);
        const r = await prisma.horario.deleteMany({ where: { id: { in: paraApagar } } });
        console.log(`${r.count} registros removidos.`);
    }

    const total = await prisma.horario.count();
    const ocupados = await prisma.horario.count({ where: { status: 'ocupado' } });
    console.log(`\nAgenda atual: ${total} horarios (${ocupados} ocupados).`);
    console.log('\nProximo passo: npx prisma db push');
}

main()
    .catch(e => { console.error('Erro na migracao:', e.message); process.exit(1); })
    .finally(() => prisma.$disconnect());
