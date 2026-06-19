// ==========================================
// 🚨 TRATAMENTO DE ERROS GLOBAIS
// ==========================================
process.on('uncaughtException', (err) => {
    console.error('CRASH FATAL (uncaughtException):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('REJEIÇÃO NÃO TRATADA:', reason);
});

// ==========================================
// 📦 IMPORTAÇÕES
// ==========================================
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { PrismaClient } = require('@prisma/client');
const express = require('express'); 
const cors = require('cors');       

const prisma = new PrismaClient();
const app = express();              
const PORTA_API = process.env.PORT || 10000; 

app.use(cors());
app.use(express.json());

const NUMEROS_ADMIN = [
    "9848494243912",  
    "73998487769",    
    "207447037857844",
    "235498106822810",
    "170991909113907"
];

const estadosUsuarios = {};
const dadosTemporarios = {}; 

// ==========================================
// 🤖 CONFIGURAÇÃO DO BOT (100% Otimizada para o Render)
// ==========================================
const client = new Client({
    authStrategy: new LocalAuth(),
    webVersionCache: {
        type: 'none' // Desativa totalmente o cache para economizar a RAM do Render
    },
    puppeteer: {
        headless: true,
        timeout: 0,
        protocolTimeout: 0,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-software-rasterizer',
            '--mute-audio',
            '--js-flags="--max-old-space-size=250"'
        ]
    }
});

// Monitor de carregamento do WhatsApp
client.on('loading_screen', (percent, message) => {
    console.log(`⏳ [Bot]: Carregando WhatsApp... ${percent}% | ${message}`);
});

// ==========================================
// 🌐 ROTAS DA API
// ==========================================
app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/api/servicos', async (req, res) => {
    try {
        const servicos = await prisma.servico.findMany({ orderBy: { id: 'asc' } });
        res.json(servicos);
    } catch (error) {
        res.status(500).json({ erro: "Erro ao buscar serviços" });
    }
});

app.post('/api/servicos', async (req, res) => {
    try {
        const { nome, preco } = req.body;
        const novoServico = await prisma.servico.create({ data: { nome, preco } });
        res.status(201).json(novoServico);
    } catch (error) {
        res.status(500).json({ erro: "Erro ao criar serviço" });
    }
});

app.delete('/api/servicos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.servico.delete({ where: { id: parseInt(id) } });
        res.json({ mensagem: "Serviço removido com sucesso" });
    } catch (error) {
        res.status(500).json({ erro: "Erro ao remover serviço" });
    }
});

app.get('/api/horarios', async (req, res) => {
    try {
        const horarios = await prisma.horario.findMany({ orderBy: { id: 'asc' } });
        res.json(horarios);
    } catch (error) {
        res.status(500).json({ erro: "Erro ao buscar agenda" });
    }
});

app.put('/api/horarios/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, cliente, servico } = req.body;

        const horarioAtualizado = await prisma.horario.update({
            where: { id: parseInt(id) },
            data: {
                status,
                cliente: status === 'disponivel' ? null : (cliente || 'Presencial/Balcão'),
                servico: status === 'disponivel' ? null : (servico || 'Não especificado'),
                whatsapp: status === 'disponivel' ? null : 'Painel Web'
            }
        });
        res.json(horarioAtualizado);
    } catch (error) {
        res.status(500).json({ erro: "Erro ao atualizar horário" });
    }
});

// ==========================================
// 🤖 EVENTOS DO BOT
// ==========================================
client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('🤖 [Bot]: QR Code gerado! Escaneie com o WhatsApp da Barbearia.');
});

client.on('ready', async () => {
    console.log('\n==================================================');
    console.log('🚀 [Bot]: Sistema Profissional com Banco de Dados Iniciado!');
    console.log(`🔒 TOTALMENTE TRANCADO! Apenas admins listados possuem acesso.`);
    console.log('==================================================\n');

    const qtdServicos = await prisma.servico.count();
    if (qtdServicos === 0) {
        await prisma.servico.createMany({
            data: [
                { nome: "Corte Disfarçado Navalhado", preco: "23,00" },
                { nome: "Barba Simples", preco: "15,00" },
                { nome: "Sobrancelha", preco: "10,00" }
            ]
        });
        console.log('📦 [Banco de Dados]: Serviços padrão adicionados com sucesso!');
    }
});

async function mostrarMenuAdmin(msg, chatId) {
    estadosUsuarios[chatId] = 'ADMIN_PAINEL';
    let menuAdmin = `🛠️ *PAINEL DO BARBEIRO*\n\n`;
    menuAdmin += `Digite o número da ação desejada:\n`;
    menuAdmin += `*[ 1 ]* - 📅 Ver Agenda Completa\n`;
    menuAdmin += `*[ 2 ]* - 🔒 Bloquear Horário\n`;
    menuAdmin += `*[ 3 ]* - 🔓 Liberar Horário (ou Liberar Todos)\n`;
    menuAdmin += `*[ 4 ]* - ✂️ Adicionar Novo Serviço\n`;
    menuAdmin += `*[ 5 ]* - ❌ Remover Serviço\n`;
    menuAdmin += `*[ 6 ]* - 🕒 Configurar Agenda (Gerar horários)\n`;
    menuAdmin += `*[ 0 ]* - Sair do Painel`;
    await msg.reply(menuAdmin);
}

function gerarHorarios(horaInicio, horaFim, intervaloMinutos) {
    let slots = [];
    let [inicioH, inicioM] = horaInicio.split(':').map(Number);
    let [fimH, fimM] = horaFim.split(':').map(Number);

    let tempoAtual = new Date(2000, 0, 1, inicioH, inicioM);
    let tempoFinal = new Date(2000, 0, 1, fimH, fimM);
    let id = 1;

    while (tempoAtual < tempoFinal) {
        let h = tempoAtual.getHours().toString().padStart(2, '0');
        let m = tempoAtual.getMinutes().toString().padStart(2, '0');
        slots.push({ id: id++, hora: `${h}:${m}`, status: "disponivel", cliente: null, servico: null, whatsapp: null });
        tempoAtual.setMinutes(tempoAtual.getMinutes() + intervaloMinutos);
    }
    return slots;
}

client.on('message', async (msg) => {
    const chatId = msg.from;
    if (chatId.endsWith('@g.us')) return; 

    const contato = await msg.getContact();
    const numeroReal = contato.number || ""; 
    
    const eAdmin = NUMEROS_ADMIN.some(num => {
        return chatId === num || numeroReal === num || chatId.includes(num + '@') || numeroReal.endsWith(num);     
    });

    if (!eAdmin) return; 

    const textoRecebido = msg.body.trim().toLowerCase();
    const nomeCliente = contato.pushname || "Cliente";

    if (textoRecebido === '!admin') return mostrarMenuAdmin(msg, chatId);

    if (estadosUsuarios[chatId] === 'ADMIN_PAINEL') {
        switch(textoRecebido) {
            case '1': 
                const todosHorarios = await prisma.horario.findMany({ orderBy: { id: 'asc' } });
                let agenda = `📅 *AGENDA DE HOJE*\n\n`;
                if (todosHorarios.length === 0) {
                    agenda += `⚠️ Nenhum horário configurado. Use a opção [ 6 ].`;
                } else {
                    todosHorarios.forEach(h => {
                        if (h.status === 'disponivel') agenda += `🟢 ${h.hora} - Livre (ID: ${h.id})\n`;
                        else agenda += `🔴 ${h.hora} - ${h.cliente} (${h.servico})\n`;
                    });
                }
                await msg.reply(agenda);
                return mostrarMenuAdmin(msg, chatId);

            case '2': 
                estadosUsuarios[chatId] = 'ADMIN_BLOQUEAR';
                const livresParaBloqueio = await prisma.horario.findMany({ where: { status: 'disponivel' }, orderBy: { id: 'asc' } });
                let menuBloqueio = `🔒 *Qual horário quer BLOQUEAR?*\n\n`;
                livresParaBloqueio.forEach(h => menuBloqueio += `[ ${h.id} ] - ${h.hora}\n`);
                return msg.reply(menuBloqueio + `\n👉 Digite o número:`);

            case '3': 
                estadosUsuarios[chatId] = 'ADMIN_LIBERAR';
                const ocupadosParaLiberar = await prisma.horario.findMany({ where: { status: 'ocupado' }, orderBy: { id: 'asc' } });
                let menuLiberar = `🔓 *Qual horário quer LIBERAR?*\n\n`;
                ocupadosParaLiberar.forEach(h => menuLiberar += `[ ${h.id} ] - ${h.hora} (${h.cliente})\n`);
                menuLiberar += `\n*[ T ]* - Liberar TODOS`;
                return msg.reply(menuLiberar + `\n\n👉 Digite o número ou 'T':`);

            case '4': 
                estadosUsuarios[chatId] = 'ADMIN_ADD_SERVICO';
                return msg.reply(`✂️ *ADICIONAR SERVIÇO*\nEx: Luzes Platinadas - 50,00`);

            case '5': 
                estadosUsuarios[chatId] = 'ADMIN_REM_SERVICO';
                const todosServicosRemover = await prisma.servico.findMany({ orderBy: { id: 'asc' } });
                let menuRemover = `❌ *Qual serviço quer APAGAR?*\n\n`;
                todosServicosRemover.forEach(s => menuRemover += `[ ${s.id} ] - ${s.nome}\n`);
                return msg.reply(menuRemover + `\n👉 Digite o número:`);

            case '6': 
                estadosUsuarios[chatId] = 'ADMIN_CONFIG_AGENDA';
                return msg.reply(`🕒 *CONFIGURAR AGENDA*\nExemplo: 09:00 - 18:00 - 45`);

            case '0': 
                delete estadosUsuarios[chatId];
                return msg.reply(`✅ Saiu do painel.`);

            default:
                return msg.reply(`❌ Opção inválida.`);
        }
    }

    if (estadosUsuarios[chatId] === 'ADMIN_BLOQUEAR') {
        const idEscolhido = parseInt(textoRecebido);
        const horario = await prisma.horario.findUnique({ where: { id: idEscolhido } });
        if (horario && horario.status === 'disponivel') {
            await prisma.horario.update({ where: { id: idEscolhido }, data: { status: 'ocupado', cliente: 'Presencial', servico: 'Balcão' } });
            await msg.reply(`✅ Bloqueado!`);
        } else await msg.reply(`❌ Inválido.`);
        return mostrarMenuAdmin(msg, chatId);
    }

    if (estadosUsuarios[chatId] === 'ADMIN_LIBERAR') {
        if (textoRecebido === 't') {
            await prisma.horario.updateMany({ data: { status: 'disponivel', cliente: null, servico: null, whatsapp: null } });
            await msg.reply(`✅ TODOS liberados!`);
            return mostrarMenuAdmin(msg, chatId);
        }
        const idEscolhido = parseInt(textoRecebido);
        const horario = await prisma.horario.findUnique({ where: { id: idEscolhido } });
        if (horario && horario.status === 'ocupado') {
            await prisma.horario.update({ where: { id: idEscolhido }, data: { status: 'disponivel', cliente: null, servico: null, whatsapp: null } });
            await msg.reply(`✅ Liberado!`);
        } else await msg.reply(`❌ Inválido.`);
        return mostrarMenuAdmin(msg, chatId);
    }

    if (estadosUsuarios[chatId] === 'ADMIN_CONFIG_AGENDA') {
        let partes = msg.body.split('-');
        if (partes.length === 3) {
            const novosSlots = gerarHorarios(partes[0].trim(), partes[1].trim(), parseInt(partes[2].trim()));
            await prisma.horario.deleteMany();
            for (const slot of novosSlots) await prisma.horario.create({ data: slot });
            await msg.reply(`✅ Agenda gerada!`);
        } else await msg.reply(`❌ Formato errado.`);
        return mostrarMenuAdmin(msg, chatId);
    }

    if (estadosUsuarios[chatId] === 'ADMIN_ADD_SERVICO') {
        let partes = msg.body.split('-');
        if (partes.length === 2) {
            await prisma.servico.create({ data: { nome: partes[0].trim(), preco: partes[1].trim() } });
            await msg.reply(`✅ Adicionado!`);
        }
        return mostrarMenuAdmin(msg, chatId);
    }

    if (estadosUsuarios[chatId] === 'ADMIN_REM_SERVICO') {
        const idEscolhido = parseInt(textoRecebido);
        const servicoExistente = await prisma.servico.findUnique({ where: { id: idEscolhido } });
        if (servicoExistente) {
            await prisma.servico.delete({ where: { id: idEscolhido } });
            await msg.reply(`✅ Apagado!`);
        }
        return mostrarMenuAdmin(msg, chatId);
    }
});

// ==========================================
// 🚀 INICIALIZAÇÃO
// ==========================================
app.listen(PORTA_API, '0.0.0.0', () => {
    console.log(`🌐 [API]: Servidor Web ativo na porta: ${PORTA_API}`);
    client.initialize();
});