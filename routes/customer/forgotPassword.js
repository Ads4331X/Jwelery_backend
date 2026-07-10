const prisma = require("../../config/prisma");
const createForgotPasswordRouter = require("../../utils/createForgotPasswordRouter");

// Mounted at /api/customer/forgot-password → /request, /verify, /reset
module.exports = createForgotPasswordRouter({
  accountType: "CUSTOMER",
  tokenType: "customer",
  senderName: "Anand Jewellers",

  findAccount: (email) =>
    prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, firstName: true, password: true },
    }),

  updatePassword: (id, hashedPassword) =>
    prisma.user.update({ where: { id }, data: { password: hashedPassword } }),
});
