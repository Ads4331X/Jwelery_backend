const prisma = require("../../config/prisma");
const createForgotPasswordRouter = require("../../utils/createForgotPasswordRouter");

// Mounted at /api/admin/forgot-password → /request, /verify, /reset
module.exports = createForgotPasswordRouter({
  accountType: "ADMIN",
  tokenType: "admin",
  senderName: "Anand Jewellers Admin",

  findAccount: (email) =>
    prisma.admin.findUnique({
      where: { email },
      select: { id: true, email: true, username: true, password: true },
    }),

  updatePassword: (id, hashedPassword) =>
    prisma.admin.update({ where: { id }, data: { password: hashedPassword } }),
});
