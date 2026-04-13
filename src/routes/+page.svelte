<script lang="ts">
	import { onMount } from 'svelte';
	import { supabase } from '$lib/supabaseClient';

	onMount(() => {
		console.log('Page mounted, Supabase client ready:', Boolean(supabase));
	});
</script>
