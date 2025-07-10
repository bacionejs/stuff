
# Stuff

A collection of tools and experiments.


# Thinky

👉 **[Open Thinky](https://bacionejs.github.io/stuff/thinky.html)**

## Purpose  

Find *who* uses *what*, i.e. repos using sonant, zzfx, aframe, audiocontext, etc.

Thinky searches code of the js13kgames competitions. It is designed mainly for newbies who are looking for examples code. For example, you go to js13kgames resource page and you see the Sonant music library and decide that it might fit your needs, but you don't know where to find examples. That is where Thinky comes in, just type `sonant` into the filter and click on a listed repository.

---



# Games Explorer

Shows games *grouped by author*, *grouped by date*, *count by year*.

👉 **[Open the Viewer](https://bacionejs.github.io/stuff/games.html)**


- The **Group by Author** query uses `parent` as the author, if available, otherwise extracts the word after the last occurrence of *by* in the `description`, otherwise categorized as *unknown*. The parent field is not reliable for extracting author information because participants might delete their repositories.

- The **Group by Year** query includes the full `description`.

- All three queries need the **year**. It is the first year in the `description` that is not found in the name, unless there are no other, otherwise it uses `created_at`, which isn't accurate because some old games got forked in the year of the cat.

