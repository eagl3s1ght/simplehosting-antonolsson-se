<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
	
	// Social media meta tags
	const siteTitle = 'Flow ~together~';
	const siteDescription = 'A radial multiplayer game where you catch flows from the sun, build layers, and compete with players around the world. Made with 🩸, 💦 & ❤️';
	const siteUrl = 'https://simplehosting.antonolsson.se'; // Update with your actual domain
	const socialImage = '/social-preview.png'; // Add a 1200x630 image to static folder
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	
	<!-- Primary Meta Tags -->
	<title>{siteTitle}</title>
	<meta name="title" content={siteTitle} />
	<meta name="description" content={siteDescription} />
	
	<!-- Open Graph / Facebook -->
	<meta property="og:type" content="website" />
	<meta property="og:url" content={siteUrl} />
	<meta property="og:title" content={siteTitle} />
	<meta property="og:description" content={siteDescription} />
	<meta property="og:image" content={`${siteUrl}${socialImage}`} />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:site_name" content={siteTitle} />
	
	<!-- Twitter -->
	<meta property="twitter:card" content="summary_large_image" />
	<meta property="twitter:url" content={siteUrl} />
	<meta property="twitter:title" content={siteTitle} />
	<meta property="twitter:description" content={siteDescription} />
	<meta property="twitter:image" content={`${siteUrl}${socialImage}`} />
	
	<!-- Additional Meta Tags -->
	<meta name="theme-color" content="#111111" />
	<meta name="author" content="Eagle Enterprises" />
	<meta name="keywords" content="multiplayer game, radial game, browser game, realtime game, flow game" />
</svelte:head>

<div style="
	min-height: 100vh;
	display: flex;
	align-items: center;
	justify-content: center;
	background: #0a0a0a;
">
	{@render children()}
</div>

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		overflow-x: hidden;
	}
</style>