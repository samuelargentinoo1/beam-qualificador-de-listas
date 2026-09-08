'use strict';
// GET /api/me — quem está logado. O painel mostra o nome no topo e lembra que
// os leads das listas dessa pessoa caem no Moskit com ela como responsável.
const { guard } = require('../lib/cloud/supa');

module.exports = async (req, res) => {
  const auth = await guard(req, res);
  if (!auth) return;
  const { user } = auth;
  res.json({ login: user.login, nome: user.nome, moskitUserId: user.moskit_user_id });
};
