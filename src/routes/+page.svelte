<script lang="ts">
	import { onMount } from 'svelte';
	import { supabase } from '$lib/supabaseClint';

	onMount(() => {
		console.log('Page mounted, Supabase client ready:', Boolean(supabase));
	});
</script>
