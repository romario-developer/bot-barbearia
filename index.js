// ==========================================
// 🚨 TRATAMENTO DE ERROS GLOBAIS (Evita que o bot morra silenciosamente)
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
const PORTA_API = process.env.PORT || 10000; // Render usa dinâmico, mas deixamos 10000 como fallback

// Configurações do Servidor Web
app.use(cors());
app.use(express.json());

// ==========================================
// 🔒 DADOS GERAIS E CONFIGURAÇÕES DO BOT
// ==========================================
const NUMEROS_ADMIN = [
    "9848494243912",  
    "73998487769",    
    "207447037857844",
    "235498106822810",
    "170991909113907"
];

const estadosUsuarios = {};
const dadosTemporarios = {}; 

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, // Isso será configurado no Render a seguir
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    }
});

// ==========================================
// 🌐 ROTAS DA API (Para o Painel Web)
// ==========================================

// Rota de Health Check (Essencial para o Render não dar timeout)
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
// 🤖 EVENTOS DO BOT DO WHATSAPP
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
        return chatId === num || 
               numeroReal === num || 
               chatId.includes(num + '@') || 
               numeroReal.endsWith(num);     
    });

    if (!eAdmin) {
        console.log(`🚫 Bloqueado Total -> ID do Chat: [${chatId}] | Número Real: [${numeroReal}]`);
        return; 
    }

    const textoRecebido = msg.body.trim().toLowerCase();
    const nomeCliente = contato.pushname || "Cliente";

    if (textoRecebido === '!admin') {
        return mostrarMenuAdmin(msg, chatId);
    }

    if (estadosUsuarios[chatId] === 'ADMIN_PAINEL') {
        switch(textoRecebido) {
            case '1': 
                const todosHorarios = await prisma.horario.findMany({ orderBy: { id: 'asc' } });
                let agenda = `📅 *AGENDA DE HOJE*\n\n`;
                
                if (todosHorarios.length === 0) {
                    agenda += `⚠️ Nenhum horário configurado para hoje. Use a opção [ 6 ] para gerar a agenda.`;
                } else {
                    todosHorarios.forEach(h => {
                        if (h.status === 'disponivel') {
                            agenda += `🟢 ${h.hora} - Livre (ID: ${h.id})\n`;
                        } else {
                            agenda += `🔴 ${h.hora} - ${h.cliente} (${h.servico})\n`;
                        }
                    });
                }
                await msg.reply(agenda);
                return mostrarMenuAdmin(msg, chatId);

            case '2': 
                estadosUsuarios[chatId] = 'ADMIN_BLOQUEAR';
                const livresParaBloqueio = await prisma.horario.findMany({ where: { status: 'disponivel' }, orderBy: { id: 'asc' } });
                let menuBloqueio = `🔒 *Qual horário quer BLOQUEAR?*\n\n`;
                livresParaBloqueio.forEach(h => {
                    menuBloqueio += `[ ${h.id} ] - ${h.hora}\n`;
                });
                return msg.reply(menuBloqueio + `\n👉 Digite o número correspondente:`);

            case '3': 
                estadosUsuarios[chatId] = 'ADMIN_LIBERAR';
                const ocupadosParaLiberar = await prisma.horario.findMany({ where: { status: 'ocupado' }, orderBy: { id: 'asc' } });
                let menuLiberar = `🔓 *Qual horário quer LIBERAR?*\n\n`;
                ocupadosParaLiberar.forEach(h => {
                    menuLiberar += `[ ${h.id} ] - ${h.hora} (${h.cliente})\n`;
                });
                menuLiberar += `\n*[ T ]* - Liberar TODOS de uma vez (Zerar a agenda do dia)`;
                return msg.reply(menuLiberar + `\n\n👉 Digite o número ou 'T':`);

            case '4': 
                estadosUsuarios[chatId] = 'ADMIN_ADD_SERVICO';
                return msg.reply(`✂️ *ADICIONAR SERVIÇO*\n\nDigite o nome e o valor separados por traço.\n*Exemplo:* Luzes Platinadas - 50,00`);

            case '5': 
                estadosUsuarios[chatId] = 'ADMIN_REM_SERVICO';
                const todosServicosRemover = await prisma.servico.findMany({ orderBy: { id: 'asc' } });
                let menuRemover = `❌ *Qual serviço quer APAGAR?*\n\n`;
                todosServicosRemover.forEach(s => {
                    menuRemover += `[ ${s.id} ] - ${s.nome}\n`;
                });
                return msg.reply(menuRemover + `\n👉 Digite o número:`);

            case '6': 
                estadosUsuarios[chatId] = 'ADMIN_CONFIG_AGENDA';
                let msgConfig = `🕒 *CONFIGURAR AGENDA*\n\n`;
                msgConfig += `⚠️ *Aviso:* Isso vai apagar a agenda atual e criar uma nova.\n\n`;
                msgConfig += `Digite: *HoraAbertura - HoraFechamento - MinutosPorCorte*\n`;
                msgConfig += `*Exemplo:* 09:00 - 18:00 - 45\n\n`;
                msgConfig += `*(Para cancelar, digite 0)*`;
                return msg.reply(msgConfig);

            case '0': 
                delete estadosUsuarios[chatId];
                return msg.reply(`✅ Você saiu do painel. O bot voltou a funcionar normalmente.`);

            default:
                return msg.reply(`❌ Opção inválida. Digite um número de 0 a 6.`);
        }
    }

    if (estadosUsuarios[chatId] === 'ADMIN_BLOQUEAR') {
        const idEscolhido = parseInt(textoRecebido);
        if (isNaN(idEscolhido)) {
            await msg.reply(`❌ Entrada inválida! Você precisa digitar o número identificador do horário.`);
            return mostrarMenuAdmin(msg, chatId);
        }
        const horario = await prisma.horario.findUnique({ where: { id: idEscolhido } });
        if (horario && horario.status === 'disponivel') {
            await prisma.horario.update({
                where: { id: idEscolhido },
                data: { status: 'ocupado', cliente: 'Presencial/Balcão', servico: 'Não especificado' }
            });
            await msg.reply(`✅ Horário das ${horario.hora} bloqueado!`);
        } else {
            await msg.reply(`❌ Horário inválido ou já ocupado.`);
        }
        return mostrarMenuAdmin(msg, chatId);
    }

    if (estadosUsuarios[chatId] === 'ADMIN_LIBERAR') {
        if (textoRecebido === 't') {
            await prisma.horario.updateMany({
                data: { status: 'disponivel', cliente: null, servico: null, whatsapp: null }
            });
            await msg.reply(`✅ TODOS os horários foram liberados! A agenda do dia foi zerada.`);
            return mostrarMenuAdmin(msg, chatId);
        }
        const idEscolhido = parseInt(textoRecebido);
        if (isNaN(idEscolhido)) {
            await msg.reply(`❌ Entrada inválida! Digite o número correspondente ao horário ou 'T' para limpar tudo.`);
            return mostrarMenuAdmin(msg, chatId);
        }
        const horario = await prisma.horario.findUnique({ where: { id: idEscolhido } });
        if (horario && horario.status === 'ocupado') {
            await prisma.horario.update({
                where: { id: idEscolhido },
                data: { status: 'disponivel', cliente: null, servico: null, whatsapp: null }
            });
            await msg.reply(`✅ Horário das ${horario.hora} liberado com sucesso!`);
        } else {
            await msg.reply(`❌ Horário inválido ou já está livre.`);
        }
        return mostrarMenuAdmin(msg, chatId);
    }

    if (estadosUsuarios[chatId] === 'ADMIN_CONFIG_AGENDA') {
        if (textoRecebido === '0') return mostrarMenuAdmin(msg, chatId);
        let partes = msg.body.split('-');
        if (partes.length === 3) {
            let horaInicio = partes[0].trim();
            let horaFim = partes[1].trim();
            let intervalo = parseInt(partes[2].trim());
            if (isNaN(intervalo) || !horaInicio.includes(':') || !horaFim.includes(':')) {
                await msg.reply(`❌ Formato inválido. Siga o exemplo: 09:00 - 18:00 - 45`);
            } else {
                const novosSlots = gerarHorarios(horaInicio, horaFim, intervalo);
                await prisma.horario.deleteMany();
                for (const slot of novosSlots) {
                    await prisma.horario.create({ data: slot });
                }
                await msg.reply(`✅ Agenda gerada com sucesso! Você tem ${novosSlots.length} horários criados no banco de dados.`);
            }
        } else {
            await msg.reply(`❌ Formato errado. Use os traços. Exemplo: 09:00 - 18:00 - 45`);
        }
        return mostrarMenuAdmin(msg, chatId);
    }

    if (estadosUsuarios[chatId] === 'ADMIN_ADD_SERVICO') {
        let partes = msg.body.split('-');
        if (partes.length === 2) {
            await prisma.servico.create({
                data: { nome: partes[0].trim(), preco: partes[1].trim() }
            });
            await msg.reply(`✅ Serviço adicionado: *${partes[0].trim()}* por R$ ${partes[1].trim()}`);
        } else {
            await msg.reply(`❌ Formato errado. Use o traço. Ex: Platinado - 60,00`);
        }
        return mostrarMenuAdmin(msg, chatId);
    }

    if (estadosUsuarios[chatId] === 'ADMIN_REM_SERVICO') {
        const idEscolhido = parseInt(textoRecebido);
        if (isNaN(idEscolhido)) {
            await msg.reply(`❌ Operação cancelada ou inválida. Retornando ao painel.`);
            return mostrarMenuAdmin(msg, chatId);
        }
        const servicoExistente = await prisma.servico.findUnique({ where: { id: idEscolhido } });
        if (servicoExistente) {
            await prisma.servico.delete({ where: { id: idEscolhido } });
            await msg.reply(`✅ Serviço *${servicoExistente.nome}* apagado do banco de dados!`);
        } else {
            await msg.reply(`❌ Número de serviço não encontrado.`);
        }
        return mostrarMenuAdmin(msg, chatId);
    }

    if (estadosUsuarios[chatId] === 'AGUARDANDO_HORARIO') {
        const opcao = parseInt(textoRecebido);
        if (isNaN(opcao)) {
            return msg.reply("❌ Ops! Não entendi. Por favor, digite apenas o *número* do horário (ex: 1, 2, 3).");
        }
        const horarioEscolhido = await prisma.horario.findFirst({ where: { id: opcao, status: 'disponivel' } });

        if (horarioEscolhido) {
            const horarioAtualizado = await prisma.horario.update({
                where: { id: horarioEscolhido.id },
                data: {
                    status: 'ocupado',
                    cliente: nomeCliente,
                    servico: dadosTemporarios[chatId].nome,
                    whatsapp: chatId
                }
            });
            delete estadosUsuarios[chatId];
            delete dadosTemporarios[chatId];
            return msg.reply(`✅ *Agendamento Confirmado!*\n\n💈 *Barbearia*\n👤 *Cliente:* ${nomeCliente}\n✂️ *Serviço:* ${horarioAtualizado.servico}\n⏰ *Horário:* ${horarioAtualizado.hora}\n\nObrigado! Te esperamos na barbearia.`);
        } else {
            return msg.reply("❌ *Opção inválida.* Esse número de horário não existe ou já foi marcado. Digite outro número:");
        }
    }

    if (estadosUsuarios[chatId] === 'AGUARDANDO_SERVICO') {
        const opcaoServico = parseInt(textoRecebido);
        if (isNaN(opcaoServico)) {
            return msg.reply("❌ Ops! Não entendi. Por favor, digite apenas o *número* do serviço que deseja (ex: 1, 2).");
        }
        const servicoEscolhido = await prisma.servico.findUnique({ where: { id: opcaoServico } });

        if (servicoEscolhido) {
            dadosTemporarios[chatId] = servicoEscolhido; 
            estadosUsuarios[chatId] = 'AGUARDANDO_HORARIO';
            const listagemDisponiveis = await prisma.horario.findMany({ where: { status: 'disponivel' }, orderBy: { id: 'asc' } });
            
            if (listagemDisponiveis.length === 0) {
                delete estadosUsuarios[chatId];
                delete dadosTemporarios[chatId];
                return msg.reply(`Poxa, *${nomeCliente}*! Todos os nossos horários de hoje já estão lotados. 😔`);
            }

            let msgHorarios = `Ótima escolha! Você selecionou *${servicoEscolhido.nome}*.\n\nEstes são os horários livres:\n\n`;
            listagemDisponiveis.forEach(h => {
                msgHorarios += `*[ ${h.id} ]* - às ${h.hora}\n`;
            });
            msgHorarios += `\n👉 Digite o *número* do horário que deseja.`;
            return msg.reply(msgHorarios); 
        } else {
            return msg.reply("❌ *Serviço não encontrado.* Digite apenas um dos números que aparecem na lista.");
        }
    }

    estadosUsuarios[chatId] = 'AGUARDANDO_SERVICO';
    const todosServicos = await prisma.servico.findMany({ orderBy: { id: 'asc' } });
    let boasVindas = `Olá, *${nomeCliente}*! Bem-vindo à nossa Barbearia. 💈\n\n`;
    boasVindas += `O que vamos fazer no visual hoje?\n\n`;
    todosServicos.forEach(s => {
        boasVindas += `*[ ${s.id} ]* - ${s.nome} (R$ ${s.preco})\n`;
    });
    boasVindas += `\n👉 *Digite o número* do serviço desejado.`;
    await msg.reply(boasVindas);
});

// ==========================================
// 🚀 INICIALIZAÇÃO GERAL
// ==========================================

// O servidor web (API) deve iniciar primeiro para evitar que o Render desista por timeout.
app.listen(PORTA_API, '0.0.0.0', () => {
    console.log(`🌐 [API]: Servidor Web ativo na porta: ${PORTA_API}`);
    
    // Somente depois que o Express está respondendo, ligamos o WhatsApp pesado
    client.initialize();
});