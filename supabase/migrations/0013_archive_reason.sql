-- Motivo digitado ao clicar "Remover" na aba de erros/removidos — até aqui
-- só existia motivo pra Cancelar (held_reason) e Segurar (removido), não
-- pra Remover. Opcional (nem todo Remover precisa de explicação), limpo de
-- volta pra null quando o pedido é restaurado (mesma lógica de
-- archived_at/archived_by em /restore).
alter table orders_shipping add column archive_reason text;
