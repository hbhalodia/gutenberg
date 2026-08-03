/**
 * External dependencies
 */
import Ajv from 'ajv';
import glob from 'fast-glob';
import { readFileSync } from 'fs';

/**
 * Internal dependencies
 */
import themeSchema from '../../schemas/json/theme.json';

describe( 'theme.json schema', () => {
	const jsonFiles = glob.sync(
		[ 'packages/*/src/**/theme.json', '{lib,phpunit,test}/**/theme.json' ],
		{ onlyFiles: true, ignore: [ '**/node_modules/**' ] }
	);
	const invalidFiles = glob.sync(
		[ 'test/integration/fixtures/schemas/*.json' ],
		{ onlyFiles: true }
	);
	const ajv = new Ajv( {
		// Used for matching unknown blocks without repeating core blocks names
		// with patternProperties in settings.blocks and settings.styles
		allowMatchingProperties: true,
	} );

	it( 'strictly adheres to the draft-07 meta schema', () => {
		// Use ajv.compile instead of ajv.validateSchema to validate the schema
		// because validateSchema only checks syntax, whereas, compile checks
		// if the schema is semantically correct with strict mode.
		// See https://github.com/ajv-validator/ajv/issues/1434#issuecomment-822982571
		const result = ajv.compile( themeSchema );

		expect( result.errors ).toBe( null );
	} );

	test( 'found theme.json files', () => {
		expect( jsonFiles.length ).toBeGreaterThan( 0 );
	} );

	test.each( jsonFiles )( 'validates schema for `%s`', ( filepath ) => {
		// We want to validate the theme.json file using the local schema.
		const { $schema, ...metadata } = require( filepath );

		// we expect the $schema property to be present in the theme.json file
		expect( $schema ).toBeTruthy();

		const result = ajv.validate( themeSchema, metadata ) || ajv.errors;

		expect( result ).toBe( true );
	} );

	test.each( invalidFiles )( 'invalidates schema for `%s`', ( filepath ) => {
		// We want to validate the theme.json file using the local schema.
		const { $schema, ...metadata } = require( filepath );

		const result = ajv.validate( themeSchema, metadata );

		expect( result ).toBe( false );
	} );

	describe( 'per-block schemas', () => {
		const definitions = themeSchema.definitions;

		// Maps that list blocks individually and fall back to a generic schema
		// for unlisted (third-party) blocks.
		const BLOCK_MAPS = [
			'settingsBlocksPropertiesComplete',
			'stylesBlocksPropertiesComplete',
			'stylesVariationBlocksPropertiesComplete',
		];

		// `patternProperties` validates in parallel with `properties`, so a
		// generic pattern branch silently rejects anything a listed block's own
		// entry allows but the pattern does not — this is what disabled every
		// block-level state (#81057). `additionalProperties` has no such
		// overlap: it only applies to keys no entry matched.
		test.each( BLOCK_MAPS )(
			'`%s` lets each listed block be the only schema applied to it',
			( mapName ) => {
				const map = definitions[ mapName ];

				expect( map.patternProperties ).toBeUndefined();
				expect( map.additionalProperties.$ref ).toMatch(
					/^#\/definitions\//
				);
				// Block names are still shape-checked, for every key.
				expect( map.propertyNames.pattern ).toBe(
					'^[a-z][a-z0-9-]*/[a-z][a-z0-9-]*$'
				);
			}
		);

		// A schema closed by its own `propertyNames` cannot be widened by
		// `allOf`-ing more members onto it: the closed member keeps rejecting
		// the added keys. Composing a block entry from a `*Complete` definition
		// is therefore always wrong, and always silent.
		test.each( BLOCK_MAPS )(
			'`%s` does not build block entries from closed definitions',
			( mapName ) => {
				const closed = Object.keys( definitions ).filter( ( name ) =>
					name.endsWith( 'Complete' )
				);

				Object.entries( definitions[ mapName ].properties )
					.filter( ( [ , value ] ) => ! value.$ref )
					.forEach( ( [ blockName, value ] ) => {
						const refs = ( value.allOf ?? [] )
							.map( ( member ) => member.$ref )
							.filter( Boolean )
							.map( ( ref ) =>
								ref.replace( '#/definitions/', '' )
							);

						expect( {
							[ blockName ]: refs.filter( ( ref ) =>
								closed.includes( ref )
							),
						} ).toEqual( { [ blockName ]: [] } );
					} );
			}
		);
	} );

	describe( 'block states', () => {
		const definitions = themeSchema.definitions;
		const styles = ( value ) => ( { version: 3, styles: value } );
		const COLOR = { color: { text: '#ffffff' } };

		// Per WP_Theme_JSON_Gutenberg::VALID_BLOCK_PSEUDO_SELECTORS. Adding a
		// block there without giving it a state-aware schema entry fails the
		// sync test below.
		const BLOCKS_WITH_STATES = [ 'core/button', 'core/navigation-link' ];

		it( 'stays in sync with WP_Theme_JSON', () => {
			const php = readFileSync(
				'lib/class-wp-theme-json-gutenberg.php',
				'utf8'
			);
			const constant = php.match(
				/const VALID_BLOCK_PSEUDO_SELECTORS = array\(([\s\S]*?)\);/
			);
			expect( constant ).not.toBeNull();

			const blocks = [
				...constant[ 1 ].matchAll( /'([\w-]+\/[\w-]+)'\s*=>/g ),
			].map( ( match ) => match[ 1 ] );
			expect( blocks.sort() ).toEqual( BLOCKS_WITH_STATES );

			const selectors = [
				...new Set(
					[ ...constant[ 1 ].matchAll( /'(:[\w-]+)'/g ) ].map(
						( match ) => match[ 1 ]
					)
				),
			];
			expect( selectors.sort() ).toEqual(
				[
					...definitions.stylesBlocksPseudoSelectorsPropertyNames
						.enum,
				].sort()
			);
		} );

		// Every block in the constant must accept every selector in it, in both
		// block maps — so a newly supported block cannot be added to the PHP
		// side and left half-wired in the schema.
		const supported = BLOCKS_WITH_STATES.flatMap( ( block ) =>
			[ ':hover', ':focus', ':focus-visible', ':active' ].map(
				( selector ) => [ block, selector ]
			)
		);

		test.each( supported )(
			'accepts `%s` `%s` on a block and inside a style variation',
			( block, selector ) => {
				const one = { blocks: { [ block ]: { [ selector ]: COLOR } } };
				const nested = { variations: { moody: one } };

				expect(
					ajv.validate( themeSchema, styles( one ) ) || ajv.errors
				).toBe( true );
				expect(
					ajv.validate( themeSchema, styles( nested ) ) || ajv.errors
				).toBe( true );
			}
		);

		const valid = [
			[
				'a pseudo state on a block element',
				{
					blocks: {
						'core/button': {
							elements: { button: { ':hover': COLOR } },
						},
					},
				},
			],
			[
				'a pseudo state on a block variation',
				{
					blocks: {
						'core/button': {
							variations: { outline: { ':hover': COLOR } },
						},
					},
				},
			],
			[
				'a responsive state alongside pseudo states',
				{ blocks: { 'core/button': { '@mobile': COLOR } } },
			],
			[
				'a custom state',
				{ blocks: { 'core/navigation-link': { '-current': COLOR } } },
			],
			[
				'a pseudo state nested in a custom state',
				{
					blocks: {
						'core/navigation-link': {
							'-current': { ':hover': COLOR },
						},
					},
				},
			],
			[
				'element pseudo states on any block',
				{
					blocks: {
						'core/paragraph': {
							elements: { link: { ':hover': COLOR } },
						},
					},
				},
			],
			[ 'an unlisted block', { blocks: { 'my-plugin/thing': COLOR } } ],
		];

		const invalid = [
			[
				'a pseudo state on a core block without support',
				{ blocks: { 'core/paragraph': { ':hover': COLOR } } },
			],
			[
				'a pseudo state on an unlisted block',
				{ blocks: { 'my-plugin/thing': { ':hover': COLOR } } },
			],
			[
				'a pseudo state outside the allowed list',
				{ blocks: { 'core/button': { ':visited': COLOR } } },
			],
			[
				'a custom state on a block without support',
				{ blocks: { 'core/button': { '-current': COLOR } } },
			],
			[
				'an unknown breakpoint',
				{ blocks: { 'core/button': { '@desktop': COLOR } } },
			],
			[
				'an unknown property beside a state',
				{ blocks: { 'core/button': { bogus: {} } } },
			],
			[
				'an unknown property inside a state',
				{ blocks: { 'core/button': { ':hover': { bogus: 1 } } } },
			],
			[
				'an unknown property inside a custom state',
				{
					blocks: {
						'core/navigation-link': { '-current': { bogus: 1 } },
					},
				},
			],
			[
				'a malformed block name',
				{ blocks: { 'core:button': COLOR } },
			],
		];

		test.each( valid )( 'accepts %s', ( _label, value ) => {
			const result =
				ajv.validate( themeSchema, styles( value ) ) || ajv.errors;

			expect( result ).toBe( true );
		} );

		test.each( invalid )( 'rejects %s', ( _label, value ) => {
			expect( ajv.validate( themeSchema, styles( value ) ) ).toBe( false );
		} );
	} );
} );
