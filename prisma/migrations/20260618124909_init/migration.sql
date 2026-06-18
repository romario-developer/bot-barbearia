-- CreateTable
CREATE TABLE "Servico" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "nome" TEXT NOT NULL,
    "preco" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Horario" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "hora" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "cliente" TEXT,
    "servico" TEXT,
    "whatsapp" TEXT
);
