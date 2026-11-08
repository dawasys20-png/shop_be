exports.up = (pgm) => {
  pgm.sql(`
    UPDATE products AS product_row
    SET data = (
      product_row.data - ARRAY[
        'detail',
        'price',
        'rating',
        'tag',
        'type',
        'image',
        'images',
        'alt',
        'description',
        'benefits',
        'ingredients',
        'howToUse',
        'warnings',
        'supplementInformation',
        'tone',
        'bestBefore'
      ]::text[]
    ) || jsonb_build_object(
      'variants',
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_strip_nulls(
              option.data || jsonb_build_object(
                'id', COALESCE(
                  option.data -> 'id',
                  to_jsonb('option-' || option.ordinality)
                ),
                'detail', COALESCE(option.data -> 'detail', product_row.data -> 'detail'),
                'rating', COALESCE(option.data -> 'rating', product_row.data -> 'rating'),
                'tag', COALESCE(option.data -> 'tag', product_row.data -> 'tag'),
                'type', COALESCE(option.data -> 'type', product_row.data -> 'type'),
                'images', COALESCE(
                  option.data -> 'images',
                  product_row.data -> 'images',
                  CASE
                    WHEN product_row.data ? 'image'
                    THEN jsonb_build_array(jsonb_build_object('url', product_row.data -> 'image'))
                  END
                ),
                'alt', COALESCE(option.data -> 'alt', product_row.data -> 'alt'),
                'description', COALESCE(option.data -> 'description', product_row.data -> 'description'),
                'benefits', COALESCE(option.data -> 'benefits', product_row.data -> 'benefits'),
                'ingredients', COALESCE(option.data -> 'ingredients', product_row.data -> 'ingredients'),
                'howToUse', COALESCE(option.data -> 'howToUse', product_row.data -> 'howToUse'),
                'warnings', COALESCE(option.data -> 'warnings', product_row.data -> 'warnings'),
                'supplementInformation', COALESCE(
                  option.data -> 'supplementInformation',
                  product_row.data -> 'supplementInformation'
                ),
                'tone', COALESCE(option.data -> 'tone', product_row.data -> 'tone'),
                'bestBefore', COALESCE(option.data -> 'bestBefore', product_row.data -> 'bestBefore'),
                'form', COALESCE(option.data -> 'form', product_row.data -> 'type', '\"Other\"'::jsonb),
                'potency', COALESCE(option.data -> 'potency', '\"Not specified\"'::jsonb),
                'packageQuantity', COALESCE(
                  option.data -> 'packageQuantity',
                  product_row.data -> 'detail',
                  '\"Not specified\"'::jsonb
                ),
                'price', COALESCE(option.data -> 'price', product_row.data -> 'price', '0'::jsonb)
              )
            )
            ORDER BY option.ordinality
          )
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(product_row.data -> 'variants') = 'array'
              THEN product_row.data -> 'variants'
              ELSE jsonb_build_array(jsonb_build_object('id', 'default'))
            END
          )
            WITH ORDINALITY AS option(data, ordinality)
        ),
        '[]'::jsonb
      )
    )
    WHERE jsonb_typeof(product_row.data) = 'object';
  `);
};
