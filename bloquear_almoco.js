// Arquivo: bloquear_almoco.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function rodarBloqueio() {
    const almoco = ["11:45", "12:00", "12:15", "12:30", "12:45", "13:00", "13:15", "13:30"];
    const dataHoje = new Date().toLocaleDateString('pt-BR');

    const resultado = await prisma.horario.updateMany({
        where: { 
            data: dataHoje, 
            hora: { in: almoco } 
        },
        data: { 
            status: 'ocupado', 
            cliente: 'ALMOÇO', 
            servico: 'Pausa para Almoço' 
        }
    });

    console.log(`✅ Bloqueio realizado com sucesso! ${resultado.count} horários ocupados.`);
    process.exit();
}

rodarBloqueio();