CREATE TABLE public.featured_store_impressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL UNIQUE,
  store_id UUID NOT NULL,
  seller_id UUID NOT NULL,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX featured_store_impressions_store_seller_time_idx
  ON public.featured_store_impressions (store_id, seller_id, viewed_at DESC);
